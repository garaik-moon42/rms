const OPENAI_API_KEY_PROPERTY = "OPENAI_API_KEY";
const OPENAI_MODEL_PROPERTY = "OPENAI_MODEL";
const DEFAULT_OPENAI_MODEL = "gpt-5.4-mini";
const OPENAI_RESPONSES_ENDPOINT = "https://api.openai.com/v1/responses";

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

type AiMetadata = {
  status: AiStatus;
  processedAt: string;
  model: string;
  classification: DocumentClassification | null;
  extraction: null;
  error: string;
};

type AiDocumentProcessingResult = {
  type: string;
  notes: string;
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
    const inputContent = buildDocumentClassificationInputContent(attachment);
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
                text: buildDocumentClassificationInstructions(),
              },
            ],
          },
          {
            role: "user",
            content: inputContent,
          },
        ],
        text: {
          format: buildDocumentClassificationTextFormat(),
        },
      }),
    });
    const statusCode = response.getResponseCode();
    const responseText = response.getContentText();

    if (statusCode < 200 || statusCode >= 300) {
      throw new Error(`OpenAI API error ${statusCode}: ${truncateText(responseText, 500)}`);
    }

    const classification = parseDocumentClassificationResponse(responseText);

    return {
      type: classification.type,
      notes: classification.notes,
      ai: {
        status: "success",
        processedAt,
        model,
        classification,
        extraction: null,
        error: "",
      },
    };
  } catch (error) {
    const errorMessage = getErrorMessage(error);

    return {
      type: "",
      notes: `AI típusfelismerés sikertelen: ${errorMessage}`,
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

function buildDocumentClassificationInputContent(
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

function buildDocumentClassificationInstructions(): string {
  return [
    "Magyar iktatórendszer dokumentumtípus-felismerő komponense vagy.",
    "A feladatod a csatolt dokumentum üzleti vagy jogi típusának meghatározása.",
    "A type mező csak a megadott típuslista egyik értéke vagy üres string lehet.",
    "Ha nem ismerhető fel megbízhatóan a dokumentum típusa, a type legyen üres string.",
    "Ilyenkor a notes röviden írja le, hogy nem sikerült felismerni a dokumentumot és miért.",
    "A confidence 0 és 1 közötti szám legyen, és tükrözze a tényleges bizonyosságot.",
    "A notes embernek hasznos, kereshető összefoglaló legyen, ne technikai log.",
    "Ha egy dokumentum forma szerint szerződés, de HR tartalmú, akkor HR típusba tartozik. Például egy munkaszerződés típusa HR.",
    `Típuslista: ${DOCUMENT_TYPES.join(", ")}.`,
  ].join("\n");
}

function buildDocumentClassificationTextFormat(): object {
  return {
    type: "json_schema",
    name: "document_classification",
    strict: true,
    schema: {
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
    },
  };
}

function parseDocumentClassificationResponse(responseText: string): DocumentClassification {
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
  const parsedClassification = JSON.parse(outputText) as Partial<DocumentClassification>;

  return normalizeDocumentClassification(parsedClassification);
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
