const REGISTRY_SHEET_NAME = "REGISTRY";
const ERROR_LABEL_NAME = "HIBA";
const UNREAD_INBOX_QUERY = "in:inbox is:unread";
const REGISTRY_NUMBER_PREFIX = "R";
const REGISTRY_NUMBER_DIGITS = 7;

const REGISTRY_HEADERS = [
  "Iktatószám",
  "Email dátuma",
  "Feladó",
  "Tárgy",
  "Fájlnév",
  "MIME típus",
  "Méret (byte)",
  "Message ID",
  "Attachment ID",
  "Csatolmány sorszám",
] as const;

const LEGACY_HEADERS_WITHOUT_REGISTRY_NUMBER = [
  "Email dátuma",
  "Feladó",
  "Tárgy",
  "Fájlnév",
  "MIME típus",
  "Méret (byte)",
  "Message ID",
  "Csatolmány sorszám",
] as const;

const LEGACY_HEADERS_WITHOUT_ATTACHMENT_ID = [
  "Iktatószám",
  "Email dátuma",
  "Feladó",
  "Tárgy",
  "Fájlnév",
  "MIME típus",
  "Méret (byte)",
  "Message ID",
  "Csatolmány sorszám",
] as const;

const REGISTRY_NUMBER_COLUMN = 1;
const MESSAGE_ID_COLUMN = 8;
const ATTACHMENT_ID_COLUMN = 9;
const ATTACHMENT_INDEX_COLUMN = 10;
const FIRST_DATA_ROW = 2;

type RegistryRow = {
  values: unknown[];
  timestamp: number;
};

function onOpen(): void {
  SpreadsheetApp.getUi()
    .createMenu("Iktatás")
    .addItem("Olvasatlan levelek feldolgozása", "processUnreadInboxAttachments")
    .addToUi();
}

function processUnreadInboxAttachments(): void {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    processUnreadInboxAttachmentsLocked();
  } finally {
    lock.releaseLock();
  }
}

function processUnreadInboxAttachmentsLocked(): void {
  const registrySheet = getOrCreateRegistrySheet();
  const processedAttachmentKeys = getProcessedAttachmentKeys(registrySheet);
  const errorLabel = getOrCreateLabel(ERROR_LABEL_NAME);
  const threads = GmailApp.search(UNREAD_INBOX_QUERY);
  const registryRows: RegistryRow[] = [];
  const successfullyProcessedThreads: GoogleAppsScript.Gmail.GmailThread[] = [];

  for (const thread of threads) {
    if (hasLabel(thread, ERROR_LABEL_NAME)) {
      continue;
    }

    try {
      registryRows.push(...collectThreadRows(thread, processedAttachmentKeys));
      successfullyProcessedThreads.push(thread);
    } catch (error) {
      thread.addLabel(errorLabel);
      console.error("Thread processing failed", {
        threadId: thread.getId(),
        error,
      });
    }
  }

  try {
    writeRegistryRowsAtTop(registrySheet, registryRows);

    for (const thread of successfullyProcessedThreads) {
      thread.markRead();
      thread.moveToArchive();
    }
  } catch (error) {
    for (const thread of successfullyProcessedThreads) {
      thread.addLabel(errorLabel);
    }

    console.error("Registry write or archive failed", { error });
  }
}

function collectThreadRows(
  thread: GoogleAppsScript.Gmail.GmailThread,
  processedAttachmentKeys: Set<string>,
): RegistryRow[] {
  const rows: RegistryRow[] = [];

  for (const message of thread.getMessages()) {
    if (!message.isUnread()) {
      continue;
    }

    const attachments = message.getAttachments({
      includeInlineImages: false,
      includeAttachments: true,
    });

    attachments.forEach((attachment, index) => {
      const attachmentIndex = index + 1;
      const attachmentKey = buildAttachmentKey(message.getId(), attachmentIndex);

      if (processedAttachmentKeys.has(attachmentKey)) {
        return;
      }

      const messageDate = message.getDate();

      rows.push({
        values: [
          messageDate,
          message.getFrom(),
          message.getSubject(),
          attachment.getName(),
          attachment.getContentType(),
          attachment.getSize(),
          message.getId(),
          buildAttachmentId(message.getId(), attachmentIndex, attachment),
          attachmentIndex,
        ],
        timestamp: messageDate.getTime(),
      });
      processedAttachmentKeys.add(attachmentKey);
    });
  }

  return rows;
}

function writeRegistryRowsAtTop(
  registrySheet: GoogleAppsScript.Spreadsheet.Sheet,
  rows: RegistryRow[],
): void {
  if (rows.length === 0) {
    return;
  }

  const nextRegistryNumber = getNextRegistryNumber(registrySheet);
  const sortedRows = rows
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((row, index) => ({
      values: [
        formatRegistryNumber(nextRegistryNumber + index),
        ...row.values,
      ],
      timestamp: row.timestamp,
    }))
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((row) => row.values);

  registrySheet.insertRowsBefore(FIRST_DATA_ROW, sortedRows.length);
  registrySheet
    .getRange(FIRST_DATA_ROW, 1, sortedRows.length, REGISTRY_HEADERS.length)
    .setValues(sortedRows);
}

function getOrCreateRegistrySheet(): GoogleAppsScript.Spreadsheet.Sheet {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const existingSheet = spreadsheet.getSheetByName(REGISTRY_SHEET_NAME);
  const sheet = existingSheet ?? spreadsheet.insertSheet(REGISTRY_SHEET_NAME);

  ensureRegistryHeaders(sheet);
  ensureRegistryNumbers(sheet);

  return sheet;
}

function ensureRegistryHeaders(sheet: GoogleAppsScript.Spreadsheet.Sheet): void {
  if (hasHeaders(sheet, LEGACY_HEADERS_WITHOUT_REGISTRY_NUMBER)) {
    sheet.insertColumnBefore(REGISTRY_NUMBER_COLUMN);
  }

  if (hasHeaders(sheet, LEGACY_HEADERS_WITHOUT_ATTACHMENT_ID)) {
    sheet.insertColumnBefore(ATTACHMENT_ID_COLUMN);
  }

  const headerRange = sheet.getRange(1, 1, 1, REGISTRY_HEADERS.length);
  const currentHeaders = headerRange.getValues()[0];
  const hasExpectedHeaders = REGISTRY_HEADERS.every(
    (header, index) => currentHeaders[index] === header,
  );

  if (!hasExpectedHeaders) {
    headerRange.setValues([[...REGISTRY_HEADERS]]);
    sheet.setFrozenRows(1);
  }
}

function hasHeaders(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  expectedHeaders: readonly string[],
): boolean {
  const currentHeaders = sheet
    .getRange(1, 1, 1, expectedHeaders.length)
    .getValues()[0];

  return expectedHeaders.every((header, index) => currentHeaders[index] === header);
}

function ensureRegistryNumbers(sheet: GoogleAppsScript.Spreadsheet.Sheet): void {
  const lastRow = sheet.getLastRow();

  if (lastRow < FIRST_DATA_ROW) {
    return;
  }

  const registryNumberRange = sheet.getRange(
    FIRST_DATA_ROW,
    REGISTRY_NUMBER_COLUMN,
    lastRow - 1,
    1,
  );
  const registryNumberRows = registryNumberRange.getValues();
  let nextRegistryNumber = getNextRegistryNumber(sheet);
  let hasMissingRegistryNumber = false;

  for (let index = registryNumberRows.length - 1; index >= 0; index -= 1) {
    if (registryNumberRows[index][0] !== "") {
      continue;
    }

    registryNumberRows[index][0] = formatRegistryNumber(nextRegistryNumber);
    nextRegistryNumber += 1;
    hasMissingRegistryNumber = true;
  }

  if (hasMissingRegistryNumber) {
    registryNumberRange.setValues(registryNumberRows);
  }
}

function getProcessedAttachmentKeys(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
): Set<string> {
  const lastRow = sheet.getLastRow();
  const processedAttachmentKeys = new Set<string>();

  if (lastRow < 2) {
    return processedAttachmentKeys;
  }

  const keyRows = sheet
    .getRange(2, MESSAGE_ID_COLUMN, lastRow - 1, ATTACHMENT_INDEX_COLUMN - MESSAGE_ID_COLUMN + 1)
    .getValues();

  for (const [messageId, , attachmentIndex] of keyRows) {
    if (messageId === "" || attachmentIndex === "") {
      continue;
    }

    processedAttachmentKeys.add(buildAttachmentKey(String(messageId), Number(attachmentIndex)));
  }

  return processedAttachmentKeys;
}

function buildAttachmentKey(messageId: string, attachmentIndex: number): string {
  return `${messageId}:${attachmentIndex}`;
}

function buildAttachmentId(
  messageId: string,
  attachmentIndex: number,
  attachment: GoogleAppsScript.Gmail.GmailAttachment,
): string {
  return `${messageId}:${attachmentIndex}:${attachment.getHash()}`;
}

function getNextRegistryNumber(sheet: GoogleAppsScript.Spreadsheet.Sheet): number {
  const lastRow = sheet.getLastRow();

  if (lastRow < FIRST_DATA_ROW) {
    return 1;
  }

  const registryNumberRows = sheet
    .getRange(FIRST_DATA_ROW, REGISTRY_NUMBER_COLUMN, lastRow - 1, 1)
    .getValues();
  const maxRegistryNumber = registryNumberRows.reduce((maxNumber, [registryNumber]) => {
    const parsedRegistryNumber = parseRegistryNumber(registryNumber);

    return Math.max(maxNumber, parsedRegistryNumber ?? 0);
  }, 0);

  return maxRegistryNumber + 1;
}

function parseRegistryNumber(value: unknown): number | null {
  const registryNumber = String(value);

  if (!registryNumber.startsWith(REGISTRY_NUMBER_PREFIX)) {
    return null;
  }

  const numericPart = registryNumber.slice(REGISTRY_NUMBER_PREFIX.length);
  const parsedNumber = Number(numericPart);

  if (!Number.isInteger(parsedNumber) || parsedNumber < 1) {
    return null;
  }

  return parsedNumber;
}

function formatRegistryNumber(registryNumber: number): string {
  return `${REGISTRY_NUMBER_PREFIX}${String(registryNumber).padStart(REGISTRY_NUMBER_DIGITS, "0")}`;
}

function getOrCreateLabel(labelName: string): GoogleAppsScript.Gmail.GmailLabel {
  const existingLabel = GmailApp.getUserLabelByName(labelName);

  return existingLabel ?? GmailApp.createLabel(labelName);
}

function hasLabel(
  thread: GoogleAppsScript.Gmail.GmailThread,
  labelName: string,
): boolean {
  return thread.getLabels().some((label) => label.getName() === labelName);
}
