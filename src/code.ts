const REGISTRY_SHEET_NAME = "REGISTRY";
const ERROR_LABEL_NAME = "HIBA";
const TARGET_DRIVE_FOLDER_ID_PROPERTY = "TARGET_DRIVE_FOLDER_ID";
const UNREAD_INBOX_QUERY = "in:inbox is:unread";
const REGISTRY_NUMBER_PREFIX = "R";
const REGISTRY_NUMBER_DIGITS = 7;

const REGISTRY_HEADERS = [
  "seq",
  "meta",
  "metaMessageId",
  "metaAttachmentIndex",
  "done",
  "view",
  "direction",
  "partner",
  "type",
  "empReim",
  "travelAuthRef",
  "notes",
  "googleDriveId",
  "id",
  "amount",
  "currency",
  "refDate",
  "dueDate",
] as const;

const SEQ_COLUMN = 1;
const META_COLUMN = 2;
const META_MESSAGE_ID_COLUMN = 3;
const META_ATTACHMENT_INDEX_COLUMN = 4;
const DONE_COLUMN = 5;
const VIEW_COLUMN = 6;
const DIRECTION_COLUMN = 7;
const PARTNER_COLUMN = 8;
const TYPE_COLUMN = 9;
const EMP_REIM_COLUMN = 10;
const NOTES_COLUMN = 12;
const GOOGLE_DRIVE_ID_COLUMN = 13;
const ID_COLUMN = 14;
const AMOUNT_COLUMN = 15;
const CURRENCY_COLUMN = 16;
const REF_DATE_COLUMN = 17;
const DUE_DATE_COLUMN = 18;
const FIRST_DATA_ROW = 2;

type AttachmentMetadata = {
  emailDate: string;
  emailSender: string;
  emailRecipients: string;
  emailSubject: string;
  attachmentFileName: string;
  attachmentMimeType: string;
  attachmentSize: number;
  messageId: string;
  attachmentIndex: number;
};

type RegistryRow = {
  attachment: GoogleAppsScript.Gmail.GmailAttachment;
  values: unknown[];
  timestamp: number;
};

function onOpen(): void {
  SpreadsheetApp.getUi()
    .createMenu("Iktatás")
    .addItem("Olvasatlan levelek feldolgozása", "processUnreadInboxAttachments")
    .addItem("Számlák letöltése a könyvelésnek", "showAccountingExportSidebar")
    .addItem("Iktatói kivonat készítése", "showRegistryExtractSidebar")
    .addSubMenu(SpreadsheetApp.getUi().createMenu("Admin")   
      .addItem("Drive célmappa beállítása", "setTargetDriveFolderId")
      .addItem("OpenAI API kulcs beállítása", "setOpenAiApiKey")
    )
    .addToUi();
}

function setTargetDriveFolderId(): void {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    "Drive célmappa beállítása",
    "Add meg a meglévő Google Drive célmappa ID-ját vagy URL-jét.",
    ui.ButtonSet.OK_CANCEL,
  );

  if (response.getSelectedButton() !== ui.Button.OK) {
    return;
  }

  const folderId = parseDriveFolderId(response.getResponseText());

  if (folderId === "") {
    ui.alert("Nem adtál meg Drive mappa azonosítót.");
    return;
  }

  try {
    const folder = DriveApp.getFolderById(folderId);
    const folderName = folder.getName();

    PropertiesService
      .getScriptProperties()
      .setProperty(TARGET_DRIVE_FOLDER_ID_PROPERTY, folderId);

    ui.alert(`Drive célmappa beállítva: ${folderName}`);
  } catch (error) {
    console.error("Could not set target Drive folder", { folderId, error });
    ui.alert("A megadott Drive mappa nem érhető el ezzel a fiókkal.");
  }
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
  const processedAttachmentKeys = new Set<string>();
  const errorLabel = getOrCreateLabel(ERROR_LABEL_NAME);
  const threads = GmailApp.search(UNREAD_INBOX_QUERY);
  const registryRows: RegistryRow[] = [];
  const successfullyProcessedThreads: GoogleAppsScript.Gmail.GmailThread[] = [];

  for (const thread of threads) {
    if (hasLabel(thread, ERROR_LABEL_NAME)) {
      continue;
    }

    try {
      registryRows.push(
        ...collectThreadRows(thread, registrySheet, processedAttachmentKeys),
      );
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
  registrySheet: GoogleAppsScript.Spreadsheet.Sheet,
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
    const processedAttachmentIndexes = getProcessedAttachmentIndexesForMessage(
      registrySheet,
      message.getId(),
    );

    attachments.forEach((attachment, index) => {
      const attachmentIndex = index + 1;
      const attachmentKey = buildAttachmentKey(message.getId(), attachmentIndex);

      if (
        processedAttachmentKeys.has(attachmentKey) ||
        processedAttachmentIndexes.has(attachmentIndex)
      ) {
        return;
      }

      const messageDate = message.getDate();
      const metadata: AttachmentMetadata = {
        emailDate: messageDate.toISOString(),
        emailSender: message.getFrom(),
        emailRecipients: getMessageRecipients(message),
        emailSubject: message.getSubject(),
        attachmentFileName: attachment.getName(),
        attachmentMimeType: attachment.getContentType(),
        attachmentSize: attachment.getSize(),
        messageId: message.getId(),
        attachmentIndex,
      };

      rows.push({
        attachment,
        values: [
          JSON.stringify(metadata, null, 2),
          message.getId(),
          attachmentIndex,
          false,
          "",
          "",
          "",
          "",
          false,
          "",
          "",
          "",
          "",
          "",
          "",
          "",
          "",
        ],
        timestamp: messageDate.getTime(),
      });
      processedAttachmentKeys.add(attachmentKey);
      processedAttachmentIndexes.add(attachmentIndex);
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
    .sort((a, b) => b.timestamp - a.timestamp)
    .map((row, index) => ({
      attachment: row.attachment,
      values: [
        formatRegistryNumber(nextRegistryNumber + rows.length - index - 1),
        ...row.values,
      ],
      timestamp: row.timestamp,
    }));
  const targetFolder = getTargetDriveFolder();
  const uploadedFileIds: string[] = [];
  let rowsInserted = false;

  try {
    sortedRows.forEach((row, index) => {
      const registryNumber = String(row.values[0]);
      const driveFile = uploadAttachmentToDrive(
        targetFolder,
        registryNumber,
        row.attachment,
      );
      const driveFileId = driveFile.getId();

      uploadedFileIds.push(driveFileId);
      row.values[GOOGLE_DRIVE_ID_COLUMN - 1] = driveFileId;
      row.values[VIEW_COLUMN - 1] = buildViewFormula(
        FIRST_DATA_ROW + index,
      );

      const aiResult = classifyDocumentAttachment(row.attachment);
      row.values[DIRECTION_COLUMN - 1] = aiResult.direction;
      row.values[PARTNER_COLUMN - 1] = aiResult.partner;
      row.values[TYPE_COLUMN - 1] = aiResult.type;
      row.values[NOTES_COLUMN - 1] = aiResult.notes;
      row.values[ID_COLUMN - 1] = aiResult.id;
      row.values[AMOUNT_COLUMN - 1] = aiResult.amount;
      row.values[CURRENCY_COLUMN - 1] = aiResult.currency;
      row.values[REF_DATE_COLUMN - 1] = aiResult.refDate;
      row.values[DUE_DATE_COLUMN - 1] = aiResult.dueDate;
      row.values[META_COLUMN - 1] = addAiMetadataToMetaJson(
        row.values[META_COLUMN - 1],
        aiResult.ai,
      );
    });

    const rowValues = sortedRows.map((row) => row.values);

    registrySheet.insertRowsBefore(FIRST_DATA_ROW, sortedRows.length);
    rowsInserted = true;
    registrySheet
      .getRange(FIRST_DATA_ROW, 1, sortedRows.length, REGISTRY_HEADERS.length)
      .setValues(rowValues);
    applyCheckboxValidation(registrySheet, FIRST_DATA_ROW, sortedRows.length);
  } catch (error) {
    trashDriveFiles(uploadedFileIds);

    if (rowsInserted) {
      deleteInsertedRegistryRows(registrySheet, sortedRows.length);
    }

    throw error;
  }
}

function getOrCreateRegistrySheet(): GoogleAppsScript.Spreadsheet.Sheet {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const existingSheet = spreadsheet.getSheetByName(REGISTRY_SHEET_NAME);
  const sheet = existingSheet ?? spreadsheet.insertSheet(REGISTRY_SHEET_NAME);

  ensureRegistryHeaders(sheet);
  ensureLatestRegistryNumber(sheet);

  return sheet;
}

function ensureRegistryHeaders(sheet: GoogleAppsScript.Spreadsheet.Sheet): void {
  ensureMetaColumns(sheet);
  ensureViewColumn(sheet);
  ensureRegistryColumnCount(sheet);

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

function ensureViewColumn(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
): void {
  if (sheet.getMaxColumns() < VIEW_COLUMN) {
    return;
  }

  const firstHeaders = sheet
    .getRange(1, 1, 1, VIEW_COLUMN)
    .getValues()[0];

  if (
    firstHeaders[DONE_COLUMN - 1] === "done" &&
    firstHeaders[VIEW_COLUMN - 1] === "direction"
  ) {
    sheet.insertColumnBefore(VIEW_COLUMN);
  }
}

function ensureMetaColumns(sheet: GoogleAppsScript.Spreadsheet.Sheet): void {
  if (sheet.getMaxColumns() < META_COLUMN) {
    return;
  }

  const firstHeaders = sheet
    .getRange(1, 1, 1, META_ATTACHMENT_INDEX_COLUMN)
    .getValues()[0];

  if (firstHeaders[0] === "seq" && firstHeaders[1] !== "meta") {
    sheet.insertColumnBefore(META_COLUMN);
  }

  const updatedFirstHeaders = sheet
    .getRange(1, 1, 1, META_ATTACHMENT_INDEX_COLUMN)
    .getValues()[0];

  if (
    updatedFirstHeaders[0] === "seq" &&
    updatedFirstHeaders[1] === "meta" &&
    updatedFirstHeaders[2] !== "metaMessageId"
  ) {
    sheet.insertColumnBefore(META_MESSAGE_ID_COLUMN);
  }

  const finalFirstHeaders = sheet
    .getRange(1, 1, 1, META_ATTACHMENT_INDEX_COLUMN)
    .getValues()[0];

  if (
    finalFirstHeaders[0] === "seq" &&
    finalFirstHeaders[1] === "meta" &&
    finalFirstHeaders[2] === "metaMessageId" &&
    finalFirstHeaders[3] !== "metaAttachmentIndex"
  ) {
    sheet.insertColumnBefore(META_ATTACHMENT_INDEX_COLUMN);
  }
}

function ensureRegistryColumnCount(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
): void {
  const missingColumnCount = REGISTRY_HEADERS.length - sheet.getMaxColumns();

  if (missingColumnCount > 0) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), missingColumnCount);
  }
}

function ensureLatestRegistryNumber(sheet: GoogleAppsScript.Spreadsheet.Sheet): void {
  const lastRow = sheet.getLastRow();

  if (lastRow < FIRST_DATA_ROW) {
    return;
  }

  const latestRegistryNumberCell = sheet.getRange(FIRST_DATA_ROW, SEQ_COLUMN);

  if (latestRegistryNumberCell.getValue() === "") {
    latestRegistryNumberCell.setValue(formatRegistryNumber(getNextRegistryNumber(sheet)));
  }
}

function getProcessedAttachmentIndexesForMessage(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  messageId: string,
): Set<number> {
  const lastRow = sheet.getLastRow();
  const processedAttachmentIndexes = new Set<number>();

  if (lastRow < FIRST_DATA_ROW) {
    return processedAttachmentIndexes;
  }

  const metaMatches = sheet
    .getRange(FIRST_DATA_ROW, META_MESSAGE_ID_COLUMN, lastRow - 1, 1)
    .createTextFinder(messageId)
    .useRegularExpression(false)
    .matchCase(true)
    .matchEntireCell(true)
    .findAll();

  for (const metaMatch of metaMatches) {
    const attachmentIndex = sheet
      .getRange(metaMatch.getRow(), META_ATTACHMENT_INDEX_COLUMN)
      .getValue();
    const parsedAttachmentIndex = Number(attachmentIndex);

    if (Number.isInteger(parsedAttachmentIndex)) {
      processedAttachmentIndexes.add(parsedAttachmentIndex);
    }
  }

  if (processedAttachmentIndexes.size > 0) {
    return processedAttachmentIndexes;
  }

  const legacyMetaMatches = sheet
    .getRange(FIRST_DATA_ROW, META_COLUMN, lastRow - 1, 1)
    .createTextFinder(messageId)
    .useRegularExpression(false)
    .matchCase(true)
    .matchEntireCell(false)
    .findAll();

  for (const metaMatch of legacyMetaMatches) {
    const metadata = parseAttachmentMetadata(String(metaMatch.getValue()));

    if (metadata === null || metadata.messageId !== messageId) {
      continue;
    }

    processedAttachmentIndexes.add(metadata.attachmentIndex);
  }

  return processedAttachmentIndexes;
}

function buildAttachmentKey(messageId: string, attachmentIndex: number): string {
  return `${messageId}:${attachmentIndex}`;
}

function getNextRegistryNumber(sheet: GoogleAppsScript.Spreadsheet.Sheet): number {
  const lastRow = sheet.getLastRow();

  if (lastRow < FIRST_DATA_ROW) {
    return 1;
  }

  const latestRegistryNumber = parseRegistryNumber(
    sheet.getRange(FIRST_DATA_ROW, SEQ_COLUMN).getValue(),
  );

  if (latestRegistryNumber !== null) {
    return latestRegistryNumber + 1;
  }

  console.warn("Could not parse latest registry number, scanning seq column");

  const registryNumberRows = sheet
    .getRange(FIRST_DATA_ROW, SEQ_COLUMN, lastRow - 1, 1)
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

function getTargetDriveFolder(): GoogleAppsScript.Drive.Folder {
  const folderId = PropertiesService
    .getScriptProperties()
    .getProperty(TARGET_DRIVE_FOLDER_ID_PROPERTY);

  if (folderId === null || folderId.trim() === "") {
    throw new Error(`Missing script property: ${TARGET_DRIVE_FOLDER_ID_PROPERTY}`);
  }

  return DriveApp.getFolderById(folderId.trim());
}

function uploadAttachmentToDrive(
  folder: GoogleAppsScript.Drive.Folder,
  registryNumber: string,
  attachment: GoogleAppsScript.Gmail.GmailAttachment,
): GoogleAppsScript.Drive.File {
  const fileName = buildDriveFileName(registryNumber, attachment.getName());
  const blob = attachment.copyBlob().setName(fileName);

  return folder.createFile(blob);
}

function buildDriveFileName(registryNumber: string, originalFileName: string): string {
  const trimmedFileName = originalFileName.trim();

  if (trimmedFileName === "") {
    return registryNumber;
  }

  return `${registryNumber}_${trimmedFileName}`;
}

function buildViewFormula(rowNumber: number): string {
  return `=HYPERLINK("https://drive.google.com/open?id=" & ${columnToA1(
    GOOGLE_DRIVE_ID_COLUMN,
  )}${rowNumber}; "🔍")`;
}

function columnToA1(column: number): string {
  let remainingColumn = column;
  let columnName = "";

  while (remainingColumn > 0) {
    const remainder = (remainingColumn - 1) % 26;
    columnName = String.fromCharCode(65 + remainder) + columnName;
    remainingColumn = Math.floor((remainingColumn - remainder - 1) / 26);
  }

  return columnName;
}

function trashDriveFiles(fileIds: string[]): void {
  for (const fileId of fileIds) {
    try {
      DriveApp.getFileById(fileId).setTrashed(true);
    } catch (error) {
      console.error("Could not trash uploaded Drive file after failure", {
        fileId,
        error,
      });
    }
  }
}

function deleteInsertedRegistryRows(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  rowCount: number,
): void {
  try {
    sheet.deleteRows(FIRST_DATA_ROW, rowCount);
  } catch (error) {
    console.error("Could not delete inserted registry rows after failure", {
      rowCount,
      error,
    });
  }
}

function parseDriveFolderId(input: string): string {
  const trimmedInput = input.trim();
  const folderUrlMatch = trimmedInput.match(/\/folders\/([a-zA-Z0-9_-]+)/);

  if (folderUrlMatch !== null) {
    return folderUrlMatch[1];
  }

  return trimmedInput;
}

function getMessageRecipients(
  message: GoogleAppsScript.Gmail.GmailMessage,
): string {
  return [message.getTo(), message.getCc(), message.getBcc()]
    .filter((recipient) => recipient !== "")
    .join(", ");
}

function parseAttachmentMetadata(metadataJson: string): AttachmentMetadata | null {
  if (metadataJson.trim() === "") {
    return null;
  }

  try {
    const parsedMetadata = JSON.parse(metadataJson) as Partial<AttachmentMetadata>;

    if (
      typeof parsedMetadata.messageId !== "string" ||
      typeof parsedMetadata.attachmentIndex !== "number" ||
      !Number.isInteger(parsedMetadata.attachmentIndex)
    ) {
      return null;
    }

    const messageId = parsedMetadata.messageId;
    const attachmentIndex = parsedMetadata.attachmentIndex;

    return {
      emailDate: String(parsedMetadata.emailDate ?? ""),
      emailSender: String(parsedMetadata.emailSender ?? ""),
      emailRecipients: String(parsedMetadata.emailRecipients ?? ""),
      emailSubject: String(parsedMetadata.emailSubject ?? ""),
      attachmentFileName: String(parsedMetadata.attachmentFileName ?? ""),
      attachmentMimeType: String(parsedMetadata.attachmentMimeType ?? ""),
      attachmentSize: Number(parsedMetadata.attachmentSize ?? 0),
      messageId,
      attachmentIndex,
    };
  } catch (error) {
    console.warn("Could not parse attachment metadata", { error });

    return null;
  }
}

function addAiMetadataToMetaJson(metadataJson: unknown, ai: AiMetadata): string {
  try {
    const metadata = JSON.parse(String(metadataJson)) as Record<string, unknown>;
    metadata.ai = ai;

    return JSON.stringify(metadata, null, 2);
  } catch (error) {
    console.warn("Could not add AI metadata to attachment metadata", { error });

    return JSON.stringify({ ai }, null, 2);
  }
}

function applyCheckboxValidation(
  sheet: GoogleAppsScript.Spreadsheet.Sheet,
  startRow: number,
  rowCount: number,
): void {
  const checkboxRule = SpreadsheetApp.newDataValidation()
    .requireCheckbox()
    .build();

  sheet.getRange(startRow, DONE_COLUMN, rowCount, 1).setDataValidation(checkboxRule);
  sheet.getRange(startRow, EMP_REIM_COLUMN, rowCount, 1).setDataValidation(checkboxRule);
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
