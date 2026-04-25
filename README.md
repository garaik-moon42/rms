# RMS - Gmail alapú iktatórendszer

Ez a projekt egy Google Sheetshez kötött Google Apps Script alapú iktatórendszer első verziója.

A rendszer egy Gmail fiók olvasatlan beérkező leveleit dolgozza fel: megkeresi az üzenetek csatolmányait, feltölti őket egy beállított Google Drive célmappába, a csatolmányok metaadatait és Drive file ID-ját beírja a scripthez tartozó Google Sheet `REGISTRY` munkalapjára, majd sikeres feldolgozás után olvasottra állítja és archiválja az érintett levelezési szálakat.

## Aktuális működés

A fő belépési pont:

```ts
function processUnreadInboxAttachments(): void
```

A feldolgozás menete:

1. Dokumentum lockot kér, hogy két futás ne írjon párhuzamosan ugyanabba a Sheetbe.
2. Létrehozza vagy előkészíti a `REGISTRY` munkalapot.
3. Beolvassa a már feldolgozott csatolmányok kulcsait.
4. Megkeresi a Gmail fiók olvasatlan inbox threadjeit ezzel a queryvel:

   ```text
   in:inbox is:unread
   ```

5. Kihagyja azokat a threadeket, amelyeken már rajta van a `HIBA` label.
6. Az olvasatlan üzenetek nem inline csatolmányairól registry sorokat készít.
7. A csatolmányokat feltölti a `TARGET_DRIVE_FOLDER_ID` Script Property-ben megadott Drive célmappába.
8. A feltöltött Drive fájl ID-ját beírja a `googleDriveId` oszlopba.
9. Az új sorokat a fejléc alá, a munkalap tetejére írja.
10. Sikeres írás után az érintett threadeket olvasottra állítja és archiválja.
11. Hiba esetén az érintett thread `HIBA` labelt kap, és a hiba bekerül a logba.

## Registry munkalap

A rendszer a `REGISTRY` nevű munkalapot használja. Ha nem létezik, létrehozza.

Az aktuális fejléc a régi iktatórendszer oszlopait követi:

| Oszlop | Tartalom |
| --- | --- |
| `seq` | Egyedi iktatószám, például `R0000001`. |
| `meta` | A Gmail üzenet és csatolmány technikai metaadatai JSON formában. |
| `metaMessageId` | Gmail message azonosító technikai kereséshez és deduplikációhoz. |
| `metaAttachmentIndex` | A csatolmány üzeneten belüli sorszáma technikai kereséshez és deduplikációhoz. |
| `done` | Checkbox. Új iktatásnál `false`; manuális feldolgozás után kell bejelölni. |
| `direction` | Bejövő/kimenő irány. Később automatikusan tölthető; jelenleg üres. |
| `partner` | Kapcsolódó partner neve. Manuálisan töltendő. |
| `type` | Dokumentumtípus. Manuálisan választandó/töltendő. |
| `empReim` | Checkbox. Kiküldetési rendelvényhez kapcsolódik-e; új iktatásnál `false`. |
| `travelAuthRef` | Kapcsolódó kiküldetési rendelvény iktatószáma. Manuálisan töltendő. |
| `notes` | Manuális feljegyzések. Új iktatásnál üres. |
| `googleDriveId` | A feltöltött dokumentum Google Drive file ID-ja. |
| `id` | Dokumentum saját azonosítója, például számlasorszám. Manuálisan töltendő. |
| `amount` | Dokumentumhoz kapcsolódó összeg. Manuálisan töltendő. |
| `currency` | Összeg devizaneme 3 karakteres kóddal. Manuálisan töltendő. |
| `refDate` | Dokumentumhoz kapcsolódó dátum, például számla kelte. Manuálisan töltendő. |
| `dueDate` | Dokumentumhoz kapcsolódó határidő. Manuálisan töltendő. |

A kód a fejlécsort ezekre az oszlopokra állítja. Ha egy korábbi `REGISTRY` munkalapon hiányoznak a `seq` utáni meta oszlopok, akkor beszúrja őket, hogy a régi adatok a megfelelő oszlopok alatt maradjanak.

## Iktatószámok

Az iktatószám formátuma:

```text
R0000001
```

Beállítások a forrásban:

```ts
const REGISTRY_NUMBER_PREFIX = "R";
const REGISTRY_NUMBER_DIGITS = 7;
```

Új sorok írásakor a rendszer optimistán a második sorban lévő, legfrissebbnek tekintett `seq` értékből számolja a következő iktatószámot. Ha ez nem értelmezhető, visszaesik a teljes `seq` oszlop átnézésére, és a legnagyobb meglévő iktatószámtól folytatja a számozást.

## Email metaadatok

Az emailből származó technikai metaadatok a `meta` oszlopba kerülnek JSON-ként. A deduplikációhoz legfontosabb mezők emellett külön oszlopba is bekerülnek: `metaMessageId` és `metaAttachmentIndex`.

A JSON szerkezete:

```json
{
  "emailDate": "",
  "emailSender": "",
  "emailRecipients": "",
  "emailSubject": "",
  "attachmentFileName": "",
  "attachmentMimeType": "",
  "attachmentSize": 0,
  "messageId": "",
  "attachmentIndex": 0
}
```

Az `emailDate` ISO dátum-stringként kerül mentésre. Az `emailRecipients` a Gmail üzenet `To`, `Cc` és `Bcc` mezőiből összeállított szöveg.

## Duplikációkezelés

A feldolgozott csatolmányok azonosítása jelenleg ezzel a kulccsal történik:

```text
<messageId>:<attachmentIndex>
```

Ezt a kulcsot elsősorban a `metaMessageId` és `metaAttachmentIndex` oszlopokból olvassa vissza. A kód az aktuális Gmail `messageId` értékére keres rá a `metaMessageId` oszlopban, és csak a találati sorok `metaAttachmentIndex` értékét olvassa. Átmeneti kompatibilitásként, ha ezekben nincs találat, a `meta` JSON oszlopban is keres.

## Hibakezelés

A hibás threadekre a rendszer `HIBA` Gmail labelt tesz.

Fontos viselkedések:

- ha egy thread feldolgozása közben hiba történik, a thread `HIBA` labelt kap;
- ha a registry írás vagy az archiválás hibázik, az addig sikeresnek tekintett threadek is `HIBA` labelt kapnak;
- a `HIBA` labellel rendelkező threadeket a következő futások kihagyják;
- sikeres feldolgozás után a thread olvasott lesz és kikerül az inboxból.

Ez szándékosan konzervatív működés: sikertelen vagy bizonytalan állapotú leveleket nem archivál csendben.

## Menü

A Sheet megnyitásakor az `onOpen()` függvény létrehoz egy egyedi menüt:

```text
Iktatás > Olvasatlan levelek feldolgozása
Iktatás > Drive célmappa beállítása
```

Az első menüpont kézzel indítja a feldolgozást a Google Sheets felületéről. A második menüpont bekéri egy már meglévő Google Drive célmappa ID-ját vagy URL-jét, ellenőrzi, hogy a mappa elérhető-e, majd elmenti a `TARGET_DRIVE_FOLDER_ID` Script Property értékbe.

Később időzített trigger is hozzáadható, de jelenleg nincs automatikus trigger definiálva a repositoryban.

## Jogosultságok

Az Apps Script manifest jelenlegi scope-jai:

```json
[
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets.currentonly"
]
```

Ezek a jelenlegi működéshez szükségesek:

- Gmail olvasás, label kezelés, olvasottra állítás és archiválás;
- Google Drive célmappa ellenőrzése és csatolmányok feltöltése;
- az aktuális Google Sheet írása.

## Projektstruktúra

```text
.
├── .clasp.json.example
├── .gitignore
├── README.md
├── appsscript.json
├── package.json
├── package-lock.json
├── scripts/
│   └── copy-manifest.mjs
├── src/
│   └── code.ts
└── tsconfig.json
```

Fontos fájlok:

- `src/code.ts`: az Apps Script TypeScript forráskódja;
- `appsscript.json`: Apps Script manifest, scope-okkal és runtime beállításokkal;
- `scripts/copy-manifest.mjs`: build után bemásolja a manifestet a `build/` mappába;
- `.clasp.json.example`: minta `clasp` konfiguráció;
- `.clasp.json`: helyi, nem verziózott `clasp` konfiguráció a konkrét `scriptId` értékkel.

## Build és deploy

A projekt TypeScriptben készül, de Google Apps Scriptbe fordított JavaScript kerül feltöltésre.

A build folyamata:

1. `tsc` lefordítja a `src/*.ts` fájlokat.
2. A kimenet a `build/` mappába kerül.
3. A `scripts/copy-manifest.mjs` bemásolja az `appsscript.json` fájlt a `build/` mappába.
4. A `clasp push` a `build/` mappa tartalmát tölti fel Apps Scriptbe.

Elérhető npm parancsok:

```bash
npm run build
npm run watch
npm run push
npm run pull
```

Windows PowerShell alatt előfordulhat, hogy a rendszer execution policy miatt az `npm.ps1` wrapper nem futtatható. Ilyenkor használható a `npm.cmd`:

```powershell
npm.cmd run build
```

## Első beállítás új Apps Script projekthez

1. Hozz létre vagy nyiss meg egy Google Sheetet.
2. A Sheetben nyisd meg: `Extensions > Apps Script`.
3. Az Apps Script editorban keresd meg a `Project Settings > Script ID` értéket.
4. Másold le a `.clasp.json.example` fájlt `.clasp.json` néven.
5. Írd be a valódi `scriptId` értéket.
6. Jelentkezz be `clasp`-pal, ha még nem történt meg:

   ```bash
   npx clasp login
   ```

7. Build és feltöltés:

   ```bash
   npm run push
   ```

8. A Sheet újratöltése után állítsd be a Drive célmappát:

   ```text
   Iktatás > Drive célmappa beállítása
   ```

   Itt megadható a meglévő Drive mappa ID-ja vagy teljes URL-je.

## Fejlesztési megjegyzések

- A `build/` mappa generált tartalom, kézzel ne ezt kell szerkeszteni.
- A tényleges forráskód a `src/` mappában van.
- A `.clasp.json` helyi konfiguráció, nem kerül verziókezelésbe.
- A Drive célmappa azonosítója Script Property-ben tárolódik `TARGET_DRIVE_FOLDER_ID` néven.
- A jelenlegi Gmail query csak olvasatlan inbox leveleket dolgoz fel.
- A rendszer csak az üzenet olvasatlan állapota alapján nézi a feldolgozandó message-eket a threaden belül.
- Inline képeket nem iktat, csak valódi csatolmányokat.
- A feldolgozott sorok dátum alapján rendezve kapnak iktatószámot, majd a legújabbak kerülnek felülre.
- A gyors iktatószám-generálás feltételezi, hogy a legfrissebb sor a fejléc alatti második sorban van.
- A meglévő registry sorokon nem fut minden alkalommal teljes iktatószám-pótlás; ez 15 000+ soros munkalapnál szándékos teljesítményvédelmi döntés.
- Az új sorok a régi iktatórendszer oszlopait kapják: a manuális mezők üresek, a `done` és `empReim` checkboxok alapértéke `false`.
- Az email/csatolmány metaadatok a `meta` oszlopban vannak JSON-ként.
- A deduplikáció a `metaMessageId` és `metaAttachmentIndex` oszlopokat használja, és nem olvassa be minden futáskor a teljes meta oszlopot.
- A feltöltött Drive fájl neve az iktatószámmal kezdődik: `R0000001_eredeti-fajlnev.ext`.
- A registry írás és az archiválás egy közös sikeres műveletsornak számít: hiba esetén a threadek `HIBA` labelt kapnak.
- Ha a Drive feltöltés után a registry írás hibázik, a kód megpróbálja kukába tenni az adott futásban már feltöltött fájlokat.

## Ismert korlátok

- Nincs automatikus trigger létrehozó segédfüggvény.
- Nincs külön tesztkörnyezet vagy mockolt Apps Script teszt.
- A `direction` mező automatikus kitöltése még TODO.
- A `type`, `partner`, pénzügyi és dátum mezők egyelőre manuálisan töltendők.
- A README-ben dokumentált működés a jelenlegi `src/code.ts` állapotot írja le.

## Tervezett következő lépések

Várható következő fejlesztések:

1. A `direction` mező automatikus kitöltése.
2. Feltöltött Drive fájlok elnevezési és mappázási szabályainak finomítása.
3. Automatikus trigger létrehozó segédfüggvény.
4. README frissítése az új működés szerint.
