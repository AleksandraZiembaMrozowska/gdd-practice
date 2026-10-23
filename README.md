# gdd-practice
Projekt ćwiczeniowy do warsztatów Grill-Driven Development.

## Domowe obowiązki

Pierwszy przepływ pozwala utworzyć dwuosobowe gospodarstwo, przekazać drugiej osobie prywatny kod i zapamiętać profil osobno na każdym urządzeniu.

### Lokalnie

Wymagany jest Node.js 24.

```sh
npm test
npm start
```

Otwórz `http://localhost:3000`. Domyślnie baza danych trafia do `data/households.sqlite`; możesz wskazać inną ścieżkę przez `DATABASE_PATH`.

### Hosting

`render.yaml` opisuje jedną usługę Node.js na Render i dysk trwały zamontowany pod `/var/data`. Użyj płatnego planu, bo Render nie udostępnia dysku trwałego planowi bezpłatnemu. Szczegóły i ograniczenia są w [ADR 0001](docs/adr/0001-render-sqlite.md).
