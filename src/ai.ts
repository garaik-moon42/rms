const OPENAI_API_KEY_PROPERTY = "OPENAI_API_KEY";
const OPENAI_MODEL_PROPERTY = "OPENAI_MODEL";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";
const INBOUND_DIRECTION_VALUE = "be ◄";
const OUTBOUND_DIRECTION_VALUE = "ki ►";
const REGISTRY_OWNER_NAME = "MOON42 RDI Kft.";

const DOCUMENT_TYPES = [
  "Árajánlat",
  "Átadás-átvételi bizonylat",
  "Átutalásos számla",
  "Díjbekérő",
  "Egyéb levél",
  "Előleg számla",
  "Érvénytelenítő számla",
  "HR",
  "Kártyás számla",
  "Készpénzes számla",
  "Megrendelő",
  "Proforma számla",
  "Szállítólevél",
  "Számlával egy tekintet alá eső okirat",
  "Szerződés",
  "Sztornó számla",
  "Teljesítési igazolás",
  "Útelszámolás",
] as const;

type DocumentType = typeof DOCUMENT_TYPES[number];
type AiStatus = "success" | "failed";

type DocumentClassificationAlternative = {
  type: DocumentType;
  confidence: number;
  reason: string;
};

type DocumentClassification = {
  type: DocumentType | "";
  confidence: number;
  language: string;
  notes: string;
  reason: string;
  alternatives: DocumentClassificationAlternative[];
};

type DocumentExtraction = {
  direction: string;
  partner: string;
  id: string;
  amount: string;
  currency: string;
  refDate: string;
  dueDate: string;
  confidence: number;
  reason: string;
};

type DocumentAnalysis = {
  classification: DocumentClassification;
  extraction: DocumentExtraction;
};

type AiMetadata = {
  status: AiStatus;
  processedAt: string;
  model: string;
  classification: DocumentClassification | null;
  extraction: DocumentExtraction | null;
  error: string;
};

type AiDocumentProcessingResult = {
  direction: string;
  partner: string;
  type: string;
  notes: string;
  id: string;
  amount: string;
  currency: string;
  refDate: string;
  dueDate: string;
  ai: AiMetadata;
};

function setOpenAiApiKey(): void {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    "OpenAI API kulcs beállítása",
    "Add meg az OpenAI API kulcsot. A kulcs Script Property-ben lesz tárolva.",
    ui.ButtonSet.OK_CANCEL,
  );

  if (response.getSelectedButton() !== ui.Button.OK) {
    return;
  }

  const apiKey = response.getResponseText().trim();

  if (!apiKey.startsWith("sk-")) {
    ui.alert("A megadott érték nem tűnik OpenAI API kulcsnak.");
    return;
  }

  PropertiesService
    .getScriptProperties()
    .setProperty(OPENAI_API_KEY_PROPERTY, apiKey);

  ui.alert("OpenAI API kulcs beállítva.");
}

function classifyDocumentAttachment(
  attachment: GoogleAppsScript.Gmail.GmailAttachment,
): AiDocumentProcessingResult {
  const processedAt = new Date().toISOString();
  const model = getOpenAiModel();

  try {
    const apiKey = getOpenAiApiKey();
    const responseText = fetchOpenAiStructuredResponse(
      apiKey,
      model,
      buildDocumentAnalysisInstructions(),
      buildDocumentInputContent(attachment),
      buildDocumentAnalysisTextFormat(),
    );
    const analysis = parseDocumentAnalysisResponse(responseText);
    const classification = analysis.classification;
    const extraction = classification.type === ""
      ? buildEmptyDocumentExtraction()
      : analysis.extraction;

    return {
      direction: extraction.direction,
      partner: extraction.partner,
      type: classification.type,
      notes: classification.notes,
      id: extraction.id,
      amount: extraction.amount,
      currency: extraction.currency,
      refDate: extraction.refDate,
      dueDate: extraction.dueDate,
      ai: {
        status: "success",
        processedAt,
        model,
        classification,
        extraction,
        error: "",
      },
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);

    return {
      direction: "",
      partner: "",
      type: "",
      notes: `AI típusfelismerés sikertelen: ${errorMessage}`,
      id: "",
      amount: "",
      currency: "",
      refDate: "",
      dueDate: "",
      ai: {
        status: "failed",
        processedAt,
        model,
        classification: null,
        extraction: null,
        error: errorMessage,
      },
    };
  }
}

function getOpenAiApiKey(): string {
  const apiKey = PropertiesService
    .getScriptProperties()
    .getProperty(OPENAI_API_KEY_PROPERTY);

  if (apiKey === null || apiKey.trim() === "") {
    throw new Error(`hiányzó Script Property: ${OPENAI_API_KEY_PROPERTY}`);
  }

  return apiKey.trim();
}

function getOpenAiModel(): string {
  const model = PropertiesService
    .getScriptProperties()
    .getProperty(OPENAI_MODEL_PROPERTY);

  return model?.trim() || DEFAULT_OPENAI_MODEL;
}

function fetchOpenAiStructuredResponse(
  apiKey: string,
  model: string,
  instructions: string,
  inputContent: object[],
  textFormat: object,
): string {
  const response = UrlFetchApp.fetch(OPENAI_RESPONSES_ENDPOINT, {
    method: "post",
    contentType: "application/json",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    muteHttpExceptions: true,
    payload: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: instructions,
            },
          ],
        },
        {
          role: "user",
          content: inputContent,
        },
      ],
      text: {
        format: textFormat,
      },
    }),
  });
  const statusCode = response.getResponseCode();
  const responseText = response.getContentText();

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`OpenAI API error ${statusCode}: ${truncateText(responseText, 500)}`);
  }

  return responseText;
}

function buildDocumentInputContent(
  attachment: GoogleAppsScript.Gmail.GmailAttachment,
): object[] {
  const fileName = attachment.getName();
  const mimeType = attachment.getContentType();
  const blob = attachment.copyBlob();
  const base64Data = Utilities.base64Encode(blob.getBytes());

  if (isSupportedImageMimeType(mimeType)) {
    return [
      {
        type: "input_text",
        text: `Fájlnév: ${fileName}\nMIME típus: ${mimeType}`,
      },
      {
        type: "input_image",
        image_url: `data:${mimeType};base64,${base64Data}`,
        detail: "auto",
      },
    ];
  }

  if (mimeType === "application/pdf") {
    return [
      {
        type: "input_text",
        text: `Fájlnév: ${fileName}\nMIME típus: ${mimeType}`,
      },
      {
        type: "input_file",
        filename: fileName,
        file_data: `data:${mimeType};base64,${base64Data}`,
      },
    ];
  }

  throw new Error(`nem támogatott fájltípus az AI feldolgozáshoz: ${mimeType}`);
}

function buildDocumentAnalysisInstructions(): string {
  return [
    "Magyar iktatórendszer dokumentumelemző komponense vagy.",
    `Az iktatórendszer tulajdonosa és nézőpontja: ${REGISTRY_OWNER_NAME}.`,
    "A feladatod a csatolt dokumentum üzleti vagy jogi típusának meghatározása, majd a registry mezők célzott kinyerése.",
    "Egyetlen strukturált JSON választ adj, classification és extraction objektummal.",
    "A classification.type mező csak a megadott típuslista egyik értéke vagy üres string lehet.",
    "Ha nem ismerhető fel megbízhatóan a dokumentum típusa, a type legyen üres string.",
    "Ilyenkor a classification.notes röviden írja le, hogy nem sikerült felismerni a dokumentumot és miért, az extraction mezői pedig maradjanak üresek.",
    "Minden confidence 0 és 1 közötti szám legyen, és tükrözze a tényleges bizonyosságot.",
    "A classification.notes embernek hasznos, kereshető összefoglaló legyen, ne technikai log.",
    "Ha egy dokumentum forma szerint szerződés, de HR tartalmú, akkor HR típusba tartozik. Például egy munkaszerződés típusa HR.",
    "Csak olyan mezőt tölts ki, amelyet a dokumentum tényleges tartalma alátámaszt.",
    "Ha egy extraction mező nem egyértelmű vagy nem található, üres stringet adj vissza.",
    "Ne töltsd az empReim és travelAuthRef mezőket; ezek nincsenek ebben a sémában.",
    `extraction.direction: a dokumentum irányát mindig ${REGISTRY_OWNER_NAME} szemszögéből állapítsd meg. Csak "${INBOUND_DIRECTION_VALUE}", "${OUTBOUND_DIRECTION_VALUE}" vagy üres string lehet. "${INBOUND_DIRECTION_VALUE}" jelentése bejövő dokumentum ${REGISTRY_OWNER_NAME} számára, "${OUTBOUND_DIRECTION_VALUE}" jelentése ${REGISTRY_OWNER_NAME} által kibocsátott vagy küldött dokumentum.`,
    `Számláknál ha ${REGISTRY_OWNER_NAME} a vevő, akkor direction="${INBOUND_DIRECTION_VALUE}". Ha ${REGISTRY_OWNER_NAME} a szállító/eladó/kibocsátó, akkor direction="${OUTBOUND_DIRECTION_VALUE}".`,
    `Szerződésnél, ajánlatnál, megrendelőnél és leveleknél is ${REGISTRY_OWNER_NAME} nézőpontját használd: ami ${REGISTRY_OWNER_NAME}-hez érkezik, "${INBOUND_DIRECTION_VALUE}", amit ${REGISTRY_OWNER_NAME} ad ki vagy küld, "${OUTBOUND_DIRECTION_VALUE}". Ha ez nem egyértelmű, üres stringet adj.`,
    `extraction.partner: mindig a ${REGISTRY_OWNER_NAME}-vel viszonyban lévő másik felet vagy feleket írd ide, soha ne magát a ${REGISTRY_OWNER_NAME}-t. Számlánál ez a másik számlaszereplő: ha ${REGISTRY_OWNER_NAME} a vevő, akkor a szállító/eladó; ha ${REGISTRY_OWNER_NAME} a szállító, akkor a vevő.`,
    `Szerződés esetén extraction.partner a másik szerződő fél vagy felek neve. HR dokumentum esetén extraction.partner mindig az a munkatárs vagy érintett személy, akire a dokumentum hivatkozik.`,
    "extraction.id: a dokumentum saját azonosítója, például számlaszám, ajánlatszám, szerződésszám, rendelésazonosító vagy ügyazonosító.",
    "extraction.amount: a dokumentum fő összege, lehetőleg bruttó vagy fizetendő végösszeg. Csak számként vagy számformátumú szövegként add meg, devizanem nélkül.",
    "extraction.currency: hárombetűs ISO devizakód, például HUF, EUR vagy USD.",
    "extraction.refDate: a dokumentum fő dátuma YYYY-MM-DD formátumban, például számla kelte, szerződés dátuma vagy teljesítés dátuma.",
    "extraction.dueDate: fizetési határidő, lejárat vagy teljesítési határidő YYYY-MM-DD formátumban.",
    "extraction.confidence: a mezőkinyerés egészére vonatkozó megbízhatóság.",
    `Típuslista: ${DOCUMENT_TYPES.join(", ")}.`,
  ].join("\n");
}

function buildDocumentAnalysisTextFormat(): object {
  return {
    type: "json_schema",
    name: "document_analysis",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["classification", "extraction"],
      properties: {
        classification: buildDocumentClassificationSchema(),
        extraction: buildDocumentExtractionSchema(),
      },
    },
  };
}

function buildDocumentClassificationSchema(): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["type", "confidence", "language", "notes", "reason", "alternatives"],
    properties: {
      type: {
        type: "string",
        enum: ["", ...DOCUMENT_TYPES],
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
      },
      language: {
        type: "string",
        description: "A dokumentum elsődleges nyelve ISO 639-1 kóddal, például hu, en vagy de.",
      },
      notes: {
        type: "string",
      },
      reason: {
        type: "string",
      },
      alternatives: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "confidence", "reason"],
          properties: {
            type: {
              type: "string",
              enum: DOCUMENT_TYPES,
            },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1,
            },
            reason: {
              type: "string",
            },
          },
        },
      },
    },
  };
}

function buildDocumentExtractionSchema(): object {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "direction",
      "partner",
      "id",
      "amount",
      "currency",
      "refDate",
      "dueDate",
      "confidence",
      "reason",
    ],
    properties: {
      direction: {
        type: "string",
        enum: ["", INBOUND_DIRECTION_VALUE, OUTBOUND_DIRECTION_VALUE],
      },
      partner: {
        type: "string",
      },
      id: {
        type: "string",
      },
      amount: {
        type: "string",
      },
      currency: {
        type: "string",
        pattern: "^$|^[A-Z]{3}$",
      },
      refDate: {
        type: "string",
        pattern: "^$|^\\d{4}-\\d{2}-\\d{2}$",
      },
      dueDate: {
        type: "string",
        pattern: "^$|^\\d{4}-\\d{2}-\\d{2}$",
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1,
      },
      reason: {
        type: "string",
      },
    },
  };
}

function parseDocumentAnalysisResponse(responseText: string): DocumentAnalysis {
  const parsedResponse = JSON.parse(responseText) as {
    output_text?: unknown;
    output?: Array<{
      content?: Array<{
        type?: string;
        text?: unknown;
        refusal?: unknown;
      }>;
    }>;
  };
  const outputText = extractOpenAiOutputText(parsedResponse);
  const parsedAnalysis = JSON.parse(outputText) as {
    classification?: Partial<DocumentClassification>;
    extraction?: Partial<DocumentExtraction>;
  };

  return {
    classification: normalizeDocumentClassification(parsedAnalysis.classification ?? {}),
    extraction: normalizeDocumentExtraction(parsedAnalysis.extraction ?? {}),
  };
}

function extractOpenAiOutputText(response: {
  output_text?: unknown;
  output?: Array<{
    content?: Array<{
      type?: string;
      text?: unknown;
      refusal?: unknown;
    }>;
  }>;
}): string {
  if (typeof response.output_text === "string" && response.output_text.trim() !== "") {
    return response.output_text;
  }

  for (const outputItem of response.output ?? []) {
    for (const contentItem of outputItem.content ?? []) {
      if (contentItem.type === "output_text" && typeof contentItem.text === "string") {
        return contentItem.text;
      }

      if (contentItem.type === "refusal" && typeof contentItem.refusal === "string") {
        throw new Error(`OpenAI refusal: ${contentItem.refusal}`);
      }
    }
  }

  throw new Error("az OpenAI válasz nem tartalmazott feldolgozható JSON szöveget");
}

function normalizeDocumentClassification(
  classification: Partial<DocumentClassification>,
): DocumentClassification {
  const type = normalizeDocumentType(classification.type);
  const alternatives = Array.isArray(classification.alternatives)
    ? classification.alternatives
      .map(normalizeDocumentClassificationAlternative)
      .filter((alternative): alternative is DocumentClassificationAlternative => alternative !== null)
    : [];

  return {
    type,
    confidence: clampConfidence(classification.confidence),
    language: String(classification.language ?? ""),
    notes: truncateText(String(classification.notes ?? ""), 1000),
    reason: truncateText(String(classification.reason ?? ""), 1000),
    alternatives,
  };
}

function normalizeDocumentClassificationAlternative(
  alternative: unknown,
): DocumentClassificationAlternative | null {
  if (typeof alternative !== "object" || alternative === null) {
    return null;
  }

  const partialAlternative = alternative as Partial<DocumentClassificationAlternative>;
  const type = normalizeDocumentType(partialAlternative.type);

  if (type === "") {
    return null;
  }

  return {
    type,
    confidence: clampConfidence(partialAlternative.confidence),
    reason: truncateText(String(partialAlternative.reason ?? ""), 1000),
  };
}

function normalizeDocumentExtraction(
  extraction: Partial<DocumentExtraction>,
): DocumentExtraction {
  return {
    direction: normalizeDirection(extraction.direction),
    partner: truncateText(String(extraction.partner ?? ""), 500),
    id: truncateText(String(extraction.id ?? ""), 200),
    amount: normalizeAmount(extraction.amount),
    currency: normalizeCurrency(extraction.currency),
    refDate: normalizeDateString(extraction.refDate),
    dueDate: normalizeDateString(extraction.dueDate),
    confidence: clampConfidence(extraction.confidence),
    reason: truncateText(String(extraction.reason ?? ""), 1000),
  };
}

function buildEmptyDocumentExtraction(): DocumentExtraction {
  return {
    direction: "",
    partner: "",
    id: "",
    amount: "",
    currency: "",
    refDate: "",
    dueDate: "",
    confidence: 0,
    reason: "",
  };
}

function normalizeDocumentType(value: unknown): DocumentType | "" {
  if (typeof value !== "string") {
    return "";
  }

  return isKnownDocumentType(value) ? value : "";
}

function isKnownDocumentType(value: string): value is DocumentType {
  return DOCUMENT_TYPES.some((documentType) => documentType === value);
}

function clampConfidence(value: unknown): number {
  const confidence = Number(value);

  if (!Number.isFinite(confidence)) {
    return 0;
  }

  return Math.min(1, Math.max(0, confidence));
}

function normalizeDirection(value: unknown): string {
  if (value === INBOUND_DIRECTION_VALUE || value === OUTBOUND_DIRECTION_VALUE) {
    return value;
  }

  if (value === "bejövő") {
    return INBOUND_DIRECTION_VALUE;
  }

  if (value === "kimenő") {
    return OUTBOUND_DIRECTION_VALUE;
  }

  return "";
}

function normalizeAmount(value: unknown): string {
  return truncateText(String(value ?? "").trim(), 100);
}

function normalizeCurrency(value: unknown): string {
  const currency = String(value ?? "").trim().toUpperCase();

  return /^[A-Z]{3}$/.test(currency) ? currency : "";
}

function normalizeDateString(value: unknown): string {
  const dateString = String(value ?? "").trim();

  return /^\d{4}-\d{2}-\d{2}$/.test(dateString) ? dateString : "";
}

function isSupportedImageMimeType(mimeType: string): boolean {
  return mimeType === "image/png" ||
    mimeType === "image/jpeg" ||
    mimeType === "image/jpg";
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 3)}...`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
