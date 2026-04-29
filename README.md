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
9. Megpróbálja AI-val felismerni a dokumentumtípust, majd a dokumentumtípus alapján kitölti a támogatott registry mezőket és a `meta.ai` adatokat.
10. Az új sorokat a fejléc alá, a munkalap tetejére írja.
11. Sikeres írás után az érintett threadeket olvasottra állítja és archiválja.
12. Hiba esetén az érintett thread `HIBA` labelt kap, és a hiba bekerül a logba.

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
| `view` | Képletből generált megtekintési link a `googleDriveId` alapján. |
| `direction` | Bejövő/kimenő irány. AI javaslatként tölthető; értéke `be ◄`, `ki ►` vagy bizonytalanság esetén üres. |
| `partner` | Kapcsolódó partner neve. AI javaslatként tölthető. |
| `type` | Dokumentumtípus. AI javaslatként tölthető; manuális ellenőrzést igényel. |
| `empReim` | Checkbox. Kiküldetési rendelvényhez kapcsolódik-e; új iktatásnál `false`. |
| `travelAuthRef` | Kapcsolódó kiküldetési rendelvény iktatószáma. Manuálisan töltendő. |
| `notes` | Kereshető dokumentumleírás vagy manuális feljegyzés. AI javaslatként tölthető. |
| `googleDriveId` | A feltöltött dokumentum Google Drive file ID-ja. |
| `id` | Dokumentum saját azonosítója, például számlasorszám. AI javaslatként tölthető. |
| `amount` | Dokumentumhoz kapcsolódó összeg. AI javaslatként tölthető. |
| `currency` | Összeg devizaneme 3 karakteres kóddal. AI javaslatként tölthető. |
| `refDate` | Dokumentumhoz kapcsolódó dátum, például számla kelte. AI javaslatként tölthető. |
| `dueDate` | Dokumentumhoz kapcsolódó határidő. AI javaslatként tölthető. |

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
Iktatás > OpenAI API kulcs beállítása
```

Az első menüpont kézzel indítja a feldolgozást a Google Sheets felületéről. A második menüpont bekéri egy már meglévő Google Drive célmappa ID-ját vagy URL-jét, ellenőrzi, hogy a mappa elérhető-e, majd elmenti a `TARGET_DRIVE_FOLDER_ID` Script Property értékbe. A harmadik menüpont bekéri és Script Property-be menti az OpenAI API kulcsot.

Később időzített trigger is hozzáadható, de jelenleg nincs automatikus trigger definiálva a repositoryban.

## Jogosultságok

Az Apps Script manifest jelenlegi scope-jai:

```json
[
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/script.external_request",
  "https://www.googleapis.com/auth/spreadsheets.currentonly"
]
```

Ezek a jelenlegi működéshez szükségesek:

- Gmail olvasás, label kezelés, olvasottra állítás és archiválás;
- Google Drive célmappa ellenőrzése és csatolmányok feltöltése;
- OpenAI API hívás `UrlFetchApp` használatával;
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
│   ├── ai.ts
│   └── code.ts
└── tsconfig.json
```

Fontos fájlok:

- `src/code.ts`: az Apps Script iktatási workflow TypeScript forráskódja;
- `src/ai.ts`: az OpenAI alapú dokumentumtípus-felismerés TypeScript forráskódja;
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
- A `view` oszlop új soroknál automatikusan `HYPERLINK` képletet kap a `googleDriveId` cellára hivatkozva.
- A registry írás és az archiválás egy közös sikeres műveletsornak számít: hiba esetén a threadek `HIBA` labelt kapnak.
- Ha a Drive feltöltés után a registry írás hibázik, a kód megpróbálja kukába tenni az adott futásban már feltöltött fájlokat.

## AI support

Az iktatott dokumentumok AI alapú előfeldolgozása két részből áll: dokumentumtípus felismerése és dokumentumtípus alapján célzott mezőkinyerés. A cél az, hogy kevesebb mezőt kelljen kézzel kitölteni, de az AI által kitöltött adatok továbbra is emberi ellenőrzést igényelnek.

### Forrásfájlok

Az AI-val kapcsolatos kód külön forrásfájlban van:

```text
src/ai.ts
```

A projekt jelenleg `module: "none"` TypeScript beállítással fordul Google Apps Scripthez. Emiatt az új fájlban ne legyen `import`/`export`; a függvények és típusok maradjanak globálisak, ahogy a jelenlegi `src/code.ts` esetén is.

A `src/code.ts` feladata az iktatási workflow vezérlése: Gmail, Drive feltöltés, AI feldolgozás bekötése, registry írás, archiválás. Az AI fájl feladata a dokumentum típusának felismerése, később pedig a dokumentumtípushoz illeszkedő adatkinyerés.

### OpenAI konfiguráció

Az OpenAI API kulcs Script Property-ben legyen tárolva:

```text
OPENAI_API_KEY
```

A menüpont:

```text
Iktatás > OpenAI API kulcs beállítása
```

Ez ugyanúgy működik, mint a Drive célmappa beállítása: bekéri az értéket, validálja minimálisan, majd Script Property-be menti.

Az alapértelmezett modell a forráskódban:

```text
gpt-5.4-mini
```

Ez felülírható az `OPENAI_MODEL` Script Property értékkel.

### AI feldolgozási pipeline

Az AI logikailag két részből áll, de technikailag egyetlen OpenAI hívásban fut le, hogy a dokumentumot ne kelljen kétszer elküldeni.

1. `classifyDocument`
   Meghatározza a dokumentum típusát és ad egy rövid, kereshető összefoglalót.

2. `extractDocumentFields`
   A már ismert dokumentumtípus alapján célzottan próbálja kitölteni a registry mezőket.

Az egyetlen strukturált válasz `classification` és `extraction` objektumot tartalmaz. Ha a dokumentumtípus nem felismerhető, a `classification.type` üres, és az `extraction` mezői is üresek maradnak.

### KNOWLEDGE munkalap

Az AI prompt kiegészíthető a `KNOWLEDGE` nevű munkalap tartalmával. Ez arra szolgál, hogy az iktatás közben előkerülő üzleti szabályokat, partnerismereteket és pontosító utasításokat deploy nélkül lehessen hozzáadni.

A munkalap elvárt oszlopai:

| Oszlop | Tartalom |
| --- | --- |
| `topic` | Témakör megnevezése. |
| `information` | Az AI-nak szóló információ vagy utasítás. |

Működés:

- a kód az első sort fejlécnek tekinti;
- csak azok a sorok kerülnek a promptba, ahol az `information` nem üres;
- a `KNOWLEDGE` lap hiánya vagy hibás fejléce nem akasztja meg az iktatást, csak kimarad a kiegészítő tudás;
- egy futáson belül a tudásanyag cache-elve van, hogy több csatolmány feldolgozásakor ne olvassa újra feleslegesen a munkalapot;
- a promptba kerülő tudásanyag mérete korlátozott, hogy ne nőjön kontrollálatlanul az OpenAI kérés.

Példa bejegyzésformátum:

```text
topic: Számlák iránya
information: Ha a MOON42 RDI Kft. a számlán vevőként szerepel, a direction értéke be ◄. Ha a MOON42 RDI Kft. a szállító, eladó vagy kibocsátó, a direction értéke ki ►.
```

### AI mezőkitöltési scope

Az AI jelenleg ezeket töltheti:

- `direction`
- `partner`
- `type`
- `notes`
- `id`
- `amount`
- `currency`
- `refDate`
- `dueDate`

Ne töltse:

- `done`
- `empReim`
- `travelAuthRef`

A `done` akkor is maradjon `false`, ha az AI feldolgozás sikeres. Az AI által kitöltött adat emberi ellenőrzést igényel.

### Notes mező elvárt tartalma

A `notes` mező ne technikai log legyen, hanem kereshető, embernek hasznos dokumentumleírás. Célja, hogy a felhasználó később a registryben keresve megtalálja a dokumentumot.

Jó `notes` tartalom példák:

- számla esetén: partner, számlaszám, összeg, deviza, keltezés, fizetési határidő, tárgy;
- szerződés esetén: felek, szerződés tárgya, aláírás dátuma, lejárat vagy határidő;
- hivatalos levél esetén: küldő, tárgy, ügyazonosító, fontos dátum;
- nyugta vagy bizonylat esetén: kereskedő, dátum, összeg, tárgy.

Ha az AI feldolgozás sikertelen, a `notes` mezőben ezt jelezni kell, például:

```text
AI feldolgozás sikertelen: nem támogatott fájltípus vagy feldolgozási hiba.
```

### Dokumentumtípus felismerés

A `type` mező dokumentumtípust jelent, nem fájlformátumot. Az AI első feladata legyen a dokumentumtípus meghatározása a kontrollált magyar típuslistából.

Az aktuális dokumentumtípus-lista:

```text
Árajánlat
Átadás-átvételi bizonylat
Átutalásos számla
Díjbekérő
Egyéb levél
Előleg számla
Érvénytelenítő számla
HR
Kártyás számla
Készpénzes számla
Megrendelő
Proforma számla
Szállítólevél
Számlával egy tekintet alá eső okirat
Szerződés
Sztornó számla
Teljesítési igazolás
Útelszámolás
```

Az AI válasza legyen strukturált, és mindig tartalmazzon megbízhatósági értéket (`confidence`). Ez nem csak tájékoztató adat: a manuális ellenőrzésnél fontos jelzés, hogy a modell mennyire biztos a besorolásban. Több dokumentumtípus határa ember számára sem mindig egyértelmű, ezért a válasz tartalmazhat alternatív kategóriákat is.

A dokumentumtípusok közötti finom üzleti elhatárolásokat, például HR és szerződés határeseteket, a `KNOWLEDGE` munkalapon érdemes rögzíteni.

Javasolt classification válasz:

```json
{
  "type": "Átutalásos számla",
  "confidence": 0.91,
  "language": "hu",
  "notes": "Example Kft. 2026-00123 számú átutalásos számlája, bruttó 152400 HUF, kelte 2026-04-12, fizetési határidő 2026-04-27.",
  "reason": "A dokumentum számlaszámot, eladót, vevőt, ÁFA összesítőt, végösszeget és átutalásos fizetési módot tartalmaz.",
  "alternatives": [
    {
      "type": "Díjbekérő",
      "confidence": 0.06,
      "reason": "Fizetési adatokat tartalmaz, de számlaszám és ÁFA összesítő is szerepel rajta."
    }
  ]
}
```

Ha az AI nem tudja felismerni a dokumentumtípust, ne adjon vissza típust. Ilyenkor a registry `type` mezője maradjon üres, a `notes` mezőbe pedig rövid, embernek hasznos leírás kerüljön arról, hogy nem sikerült felismerni a dokumentumot és miért. A pontos típust ilyenkor a manuális ellenőrzés állapítja meg.

Példa sikertelen felismerésre:

```json
{
  "type": "",
  "confidence": 0.28,
  "language": "hu",
  "notes": "AI típusfelismerés sikertelen: a dokumentum csak részben olvasható, és nem tartalmaz egyértelmű számla-, szerződés- vagy HR-jellemzőket.",
  "reason": "A dokumentumból nem azonosítható megbízhatóan a jogi vagy üzleti funkció.",
  "alternatives": [
    {
      "type": "Egyéb levél",
      "confidence": 0.24,
      "reason": "Általános levélre utaló töredékek vannak, de a tartalom nem elég egyértelmű."
    }
  ]
}
```

### Mezőkinyerés

A második lépcsőben, amikor a dokumentumtípus már ismert, az AI típusfüggő instrukció alapján töltheti a mezőket:

- `direction`
- `partner`
- `id`
- `amount`
- `currency`
- `refDate`
- `dueDate`

Az `empReim` és `travelAuthRef` mezőket egyelőre ne töltse az AI.

A mezőkinyerés szigorú JSON schema alapján történik. Minden mező üres string lehet, mert a rendszer nem akar kikényszeríteni bizonytalan adatot. Az AI csak akkor tölthet mezőt, ha azt a dokumentum tényleges tartalma alátámasztja.

A mezők jelentése:

- `direction`: `be ◄`, `ki ►` vagy üres, a `KNOWLEDGE` munkalapon megadott üzleti szabályok szerint;
- `partner`: a kapcsolódó partner neve vagy nevei, a `KNOWLEDGE` munkalapon megadott üzleti szabályok szerint;
- `id`: dokumentumazonosító, például számlaszám, ajánlatszám, szerződésszám vagy rendelésazonosító;
- `amount`: a fő összeg, lehetőleg bruttó vagy fizetendő végösszeg, devizanem nélkül;
- `currency`: 3 karakteres ISO devizakód;
- `refDate`: fő dokumentumdátum `YYYY-MM-DD` formátumban;
- `dueDate`: határidő, lejárat vagy fizetési határidő `YYYY-MM-DD` formátumban.

### Meta JSON bővítése

Az AI teljes válaszát audit célból a `meta` JSON-ba is be kell írni egy `ai` blokk alá.

Javasolt szerkezet:

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
  "attachmentIndex": 0,
  "ai": {
    "status": "success",
    "processedAt": "2026-04-26T12:00:00.000Z",
    "model": "gpt-5.4-mini",
    "classification": {
      "type": "Átutalásos számla",
      "confidence": 0.86,
      "language": "hu",
      "notes": "",
      "reason": "",
      "alternatives": []
    },
    "extraction": {
      "direction": "be ◄",
      "partner": "Example Kft.",
      "id": "2026-00123",
      "amount": "152400",
      "currency": "HUF",
      "refDate": "2026-04-12",
      "dueDate": "2026-04-27",
      "confidence": 0.82,
      "reason": "A számla fejlécében szerepel a számlaszám, a végösszeg, a deviza, a kelte és a fizetési határidő."
    },
    "error": ""
  }
}
```

Sikertelen AI feldolgozásnál:

```json
{
  "ai": {
    "status": "failed",
    "processedAt": "2026-04-26T12:00:00.000Z",
    "model": "",
    "classification": null,
    "extraction": null,
    "error": "Unsupported file type"
  }
}
```

### Támogatott fájlformátumok az AI-hoz

Kezdeti elvárás:

- PDF
- PNG
- TIFF
- JPEG / JPG
- DOCX

Javasolt kezelés:

- PDF: közvetlen AI feldolgozás, implementálva.
- PNG: közvetlen AI feldolgozás, implementálva.
- JPEG / JPG: közvetlen AI feldolgozás, implementálva.
- TIFF: konvertálni kell PDF-re vagy PNG/JPEG-re, ez még nincs implementálva.
- DOCX: Google Drive-on keresztül PDF-re konvertálni, ez még nincs implementálva.

Ha a fájl nem támogatott vagy nem konvertálható, ne akadjon meg az iktatás. Ilyenkor:

- `done` maradjon `false`;
- `type` maradjon üres;
- `notes` jelezze, hogy az AI feldolgozás sikertelen;
- `meta.ai.status` legyen `failed`.

### OpenAI API technikai megoldás

Az AI integráció a Responses API-t és strukturált JSON kimenetet használ. A dokumentum Apps Scriptből `UrlFetchApp` alapú direkt HTTP hívással, base64 data URL-ként kerül átadásra; nincs npm SDK használat. A típusfelismerés és mezőkinyerés egy közös API hívásban történik, hogy a dokumentumot csak egyszer kelljen elküldeni az OpenAI felé.

Az OpenAI API kulcsot minden hívásnál Script Property-ből kell olvasni:

```text
OPENAI_API_KEY
```

Az API hívás szigorú JSON schema alapján kér választ, hogy ne kelljen szabad szövegű modellválaszt parse-olni.

## Ismert korlátok

- Nincs automatikus trigger létrehozó segédfüggvény.
- Nincs külön tesztkörnyezet vagy mockolt Apps Script teszt.
- Az AI által töltött mezők továbbra is emberi ellenőrzést igényelnek.
- Az AI jelenleg csak PDF, PNG és JPEG/JPG fájlokat dolgoz fel közvetlenül.
- A TIFF és DOCX konverzió még nincs implementálva.
- A README-ben dokumentált működés a jelenlegi `src/code.ts` és `src/ai.ts` állapotot írja le.

## Tervezett következő lépések

Várható következő fejlesztések:

1. TIFF és DOCX konverzió az AI feldolgozáshoz.
2. Dokumentumtípusonként finomított mezőkinyerési instrukciók és sémák.
3. Feltöltött Drive fájlok elnevezési és mappázási szabályainak finomítása.
4. Automatikus trigger létrehozó segédfüggvény.
