const status = document.querySelector('#status');
const accessView = document.querySelector('#access-view');
const inviteView = document.querySelector('#invite-view');
const householdView = document.querySelector('#household-view');
const createForm = document.querySelector('#create-form');
const joinForm = document.querySelector('#join-form');
const inviteCodeValue = document.querySelector('#invite-code-value');
const profileSelect = document.querySelector('#profile-select');
const profileList = document.querySelector('#profile-list');

let currentHousehold = null;
let currentProfile = null;

function showView(view) {
  for (const candidate of [accessView, inviteView, householdView]) {
    candidate.hidden = candidate !== view;
  }
}

function announce(message = '') {
  status.textContent = message;
  status.classList.toggle('status-visible', Boolean(message));
}

async function requestJson(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Nie udało się zapisać zmian.');
  return result;
}

function renderHousehold(household, profile) {
  currentHousehold = household;
  currentProfile = profile;
  profileSelect.replaceChildren();
  profileList.replaceChildren();

  for (const item of household.profiles) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = item.name;
    option.selected = item.id === profile.id;
    profileSelect.append(option);

    const card = document.createElement('div');
    card.className = `profile-card${item.id === profile.id ? ' profile-card-active' : ''}`;
    const name = document.createElement('strong');
    name.textContent = item.name;
    const role = document.createElement('span');
    role.textContent = item.id === profile.id ? 'Ten profil na tym urządzeniu' : 'Drugi profil';
    card.append(name, role);
    profileList.append(card);
  }

  showView(householdView);
}

createForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  announce('Tworzenie gospodarstwa…');
  const formData = new FormData(createForm);
  try {
    const result = await requestJson('/api/households', {
      method: 'POST',
      body: { names: [formData.get('firstName'), formData.get('secondName')] },
    });
    currentHousehold = { ...result.household, profiles: result.profiles };
    currentProfile = result.profile;
    inviteCodeValue.textContent = result.inviteCode;
    createForm.reset();
    announce('');
    showView(inviteView);
  } catch (error) {
    announce(error.message);
  }
});

joinForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  announce('Dołączanie do gospodarstwa…');
  const formData = new FormData(joinForm);
  try {
    const result = await requestJson('/api/households/join', {
      method: 'POST',
      body: { code: formData.get('code').trim() },
    });
    joinForm.reset();
    announce('');
    renderHousehold({ ...result.household, profiles: result.profiles }, result.profile);
  } catch (error) {
    announce(error.message);
  }
});

document.querySelector('#copy-code').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(inviteCodeValue.textContent);
    announce('Kod skopiowany. Przekaż go drugiej osobie.');
  } catch {
    announce('Nie udało się skopiować kodu. Zaznacz go i skopiuj ręcznie.');
  }
});

document.querySelector('#continue-button').addEventListener('click', () => {
  announce('');
  renderHousehold(currentHousehold, currentProfile);
});

profileSelect.addEventListener('change', async () => {
  announce('Zapisywanie profilu…');
  try {
    const result = await requestJson('/api/session/profile', {
      method: 'PUT',
      body: { profileId: profileSelect.value },
    });
    announce('');
    renderHousehold(result.household, result.profile);
  } catch (error) {
    announce(error.message);
    if (currentHousehold && currentProfile) renderHousehold(currentHousehold, currentProfile);
  }
});

async function loadSession() {
  try {
    const session = await requestJson('/api/session');
    if (session.household && session.profile) {
      renderHousehold(session.household, session.profile);
      return;
    }
  } catch (error) {
    announce(error.message);
    return;
  }
  showView(accessView);
}

loadSession();
