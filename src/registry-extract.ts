const REGISTRY_EXTRACT_LOG_PREFIX = "[registry-extract]";
const REGISTRY_EXTRACT_SIDEBAR_FILE = "registry-extract-sidebar";
const REGISTRY_EXTRACT_SIDEBAR_TITLE = "Iktatói kivonat készítése";
const REGISTRY_EXTRACT_PROGRESS_CACHE_PREFIX = "registry-extract-progress:";
const REGISTRY_EXTRACT_PROGRESS_TTL_SECONDS = 21600;
const DOCUMENTS_SHEET_NAME = "DOCUMENTS";
const REGISTRY_EXTRACT_EXCLUDED_COLUMNS = [
  META_COLUMN,
  META_MESSAGE_ID_COLUMN,
  META_ATTACHMENT_INDEX_COLUMN,
  GOOGLE_DRIVE_ID_COLUMN,
] as const;

type RegistryExtractDocument = {
  rowNumber: number;
  registryNumber: string;
  partner: string;
  type: string;
  driveFileId: string;
  originalFileName: string;
  displayValues: string[];
};

type RegistryExtractSkippedRow = {
  rowNumber: number;
  reason: string;
};

type RegistryExtractError = {
  rowNumber: number;
  registryNumber: string;
  driveFileId: string;
  message: string;
};

type RegistryExtractPreview = {
  ok: boolean;
  targetFolderId: string;
  targetFolderName: string;
  targetFolderIsEmpty: boolean;
  selectedRowCount: number;
  documentCount: number;
  skippedCount: number;
  skippedRows: RegistryExtractSkippedRow[];
  warnings: string[];
  errors: string[];
};

type RegistryExtractResult = RegistryExtractPreview & {
  copiedCount: number;
  copiedFiles: Array<{
    rowNumber: number;
    registryNumber: string;
    sourceFileId: string;
    targetFileId: string;
    targetFileName: string;
  }>;
  copyErrors: RegistryExtractError[];
  spreadsheetId: string;
  spreadsheetUrl: string;
  spreadsheetName: string;
};

type RegistryExtractProgress = {
  id: string;
  status: "idle" | "running" | "blocked" | "finished";
  totalCount: number;
  processedCount: number;
  copiedCount: number;
  errorCount: number;
  currentRegistryNumber: string;
  message: string;
};

function showRegistryExtractSidebar(): void {
  const html = HtmlService
    .createHtmlOutputFromFile(REGISTRY_EXTRACT_SIDEBAR_FILE)
    .setTitle(REGISTRY_EXTRACT_SIDEBAR_TITLE);

  SpreadsheetApp.getUi().showSidebar(html);
}

function previewRegistryExtract(targetFolderInput: string): RegistryExtractPreview {
  console.log(`${REGISTRY_EXTRACT_LOG_PREFIX} preview started`, {
    targetFolderInput,
  });

  const preview = runRegistryExtractOperation(
    "preview",
    () => buildRegistryExtractPreview(targetFolderInput),
    targetFolderInput,
  );

  console.log(`${REGISTRY_EXTRACT_LOG_PREFIX} preview finished`, {
    targetFolderId: preview.targetFolderId,
    selectedRowCount: preview.selectedRowCount,
    documentCount: preview.documentCount,
    skippedCount: preview.skippedCount,
    errorCount: preview.errors.length,
  });

  return preview;
}

function createRegistryExtract(
  targetFolderInput: string,
  progressId?: string,
): RegistryExtractResult {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    return createRegistryExtractLocked(targetFolderInput, progressId ?? "");
  } finally {
    lock.releaseLock();
  }
}

function createRegistryExtractLocked(
  targetFolderInput: string,
  progressId: string,
): RegistryExtractResult {
  console.log(`${REGISTRY_EXTRACT_LOG_PREFIX} create started`, {
    targetFolderInput,
  });

  const preview = runRegistryExtractOperation(
    "create preview",
    () => buildRegistryExtractPreview(targetFolderInput),
    targetFolderInput,
  );
  const result: RegistryExtractResult = {
    ...preview,
    copiedCount: 0,
    copiedFiles: [],
    copyErrors: [],
    spreadsheetId: "",
    spreadsheetUrl: "",
    spreadsheetName: "",
  };

  if (!preview.ok) {
    updateRegistryExtractProgress(progressId, {
      id: progressId,
      status: "blocked",
      totalCount: preview.documentCount,
      processedCount: 0,
      copiedCount: 0,
      errorCount: preview.errors.length,
      currentRegistryNumber: "",
      message: "A kivonat készítése nem indult el, mert az ellenőrzés hibát talált.",
    });

    return result;
  }

  const targetFolder = DriveApp.getFolderById(preview.targetFolderId);
  const documents = collectSelectedRegistryExtractDocuments();
  const copiedDocuments: Array<{
    document: RegistryExtractDocument;
    targetFileId: string;
    targetFileName: string;
  }> = [];

  updateRegistryExtractProgress(progressId, {
    id: progressId,
    status: "running",
    totalCount: documents.documents.length,
    processedCount: 0,
    copiedCount: 0,
    errorCount: 0,
    currentRegistryNumber: "",
    message: "Dokumentumok másolása folyamatban...",
  });

  for (const document of documents.documents) {
    try {
      updateRegistryExtractProgress(progressId, {
        id: progressId,
        status: "running",
        totalCount: documents.documents.length,
        processedCount: result.copiedCount + result.copyErrors.length,
        copiedCount: result.copiedCount,
        errorCount: result.copyErrors.length,
        currentRegistryNumber: document.registryNumber,
        message: `${document.registryNumber} másolása...`,
      });

      const sourceFile = DriveApp.getFileById(document.driveFileId);
      const targetFileName = buildRegistryExtractTargetFileName(
        document,
        sourceFile.getName(),
      );
      const targetFile = sourceFile.makeCopy(targetFileName, targetFolder);

      result.copiedCount += 1;
      result.copiedFiles.push({
        rowNumber: document.rowNumber,
        registryNumber: document.registryNumber,
        sourceFileId: document.driveFileId,
        targetFileId: targetFile.getId(),
        targetFileName,
      });
      copiedDocuments.push({
        document,
        targetFileId: targetFile.getId(),
        targetFileName,
      });
      console.log(`${REGISTRY_EXTRACT_LOG_PREFIX} copied row ${document.rowNumber}`, {
        registryNumber: document.registryNumber,
        sourceFileId: document.driveFileId,
        targetFileId: targetFile.getId(),
        targetFileName,
      });
    } catch (error) {
      const message = getRegistryExtractErrorMessage(error);

      result.copyErrors.push({
        rowNumber: document.rowNumber,
        registryNumber: document.registryNumber,
        driveFileId: document.driveFileId,
        message,
      });
      console.error(`${REGISTRY_EXTRACT_LOG_PREFIX} copy failed row ${document.rowNumber}`, {
        registryNumber: document.registryNumber,
        driveFileId: document.driveFileId,
        error,
      });
    }

    updateRegistryExtractProgress(progressId, {
      id: progressId,
      status: "running",
      totalCount: documents.documents.length,
      processedCount: result.copiedCount + result.copyErrors.length,
      copiedCount: result.copiedCount,
      errorCount: result.copyErrors.length,
      currentRegistryNumber: document.registryNumber,
      message: `${result.copiedCount + result.copyErrors.length} / ${documents.documents.length} dokumentum feldolgozva`,
    });
  }

  try {
    updateRegistryExtractProgress(progressId, {
      id: progressId,
      status: "running",
      totalCount: documents.documents.length,
      processedCount: documents.documents.length,
      copiedCount: result.copiedCount,
      errorCount: result.copyErrors.length,
      currentRegistryNumber: "",
      message: "DOCUMENTS munkalap létrehozása...",
    });

    const spreadsheet = createRegistryExtractSpreadsheet(
      targetFolder,
      copiedDocuments,
    );

    result.spreadsheetId = spreadsheet.getId();
    result.spreadsheetUrl = spreadsheet.getUrl();
    result.spreadsheetName = spreadsheet.getName();
  } catch (error) {
    result.copyErrors.push({
      rowNumber: 0,
      registryNumber: "",
      driveFileId: "",
      message: `DOCUMENTS munkalap létrehozása sikertelen: ${getRegistryExtractErrorMessage(error)}`,
    });
  }

  updateRegistryExtractProgress(progressId, {
    id: progressId,
    status: "finished",
    totalCount: documents.documents.length,
    processedCount: documents.documents.length,
    copiedCount: result.copiedCount,
    errorCount: result.copyErrors.length,
    currentRegistryNumber: "",
    message: "Iktatói kivonat kész.",
  });

  console.log(`${REGISTRY_EXTRACT_LOG_PREFIX} create finished`, {
    copiedCount: result.copiedCount,
    skippedCount: result.skippedCount,
    copyErrorCount: result.copyErrors.length,
    spreadsheetId: result.spreadsheetId,
  });

  return result;
}

function getRegistryExtractProgress(progressId: string): RegistryExtractProgress {
  const cacheKey = buildRegistryExtractProgressCacheKey(progressId);
  const cachedProgress = cacheKey === ""
    ? null
    : CacheService.getUserCache().get(cacheKey);

  if (cachedProgress === null) {
    return buildEmptyRegistryExtractProgress(progressId);
  }

  try {
    return JSON.parse(cachedProgress) as RegistryExtractProgress;
  } catch (error) {
    console.warn(`${REGISTRY_EXTRACT_LOG_PREFIX} could not parse progress`, {
      progressId,
      error,
    });

    return buildEmptyRegistryExtractProgress(progressId);
  }
}

function buildRegistryExtractPreview(targetFolderInput: string): RegistryExtractPreview {
  const errors: string[] = [];
  const warnings: string[] = [];
  let targetFolderId = "";
  let targetFolderName = "";
  let targetFolderIsEmpty = false;

  targetFolderId = parseDriveFolderId(targetFolderInput);

  if (targetFolderId === "") {
    errors.push("Hiányzik a cél Google Drive mappa azonosítója.");
  } else {
    try {
      const targetFolder = DriveApp.getFolderById(targetFolderId);

      targetFolderName = targetFolder.getName();
      targetFolderIsEmpty = isRegistryExtractDriveFolderEmpty(targetFolder);

      if (!targetFolderIsEmpty) {
        warnings.push("A cél Google Drive mappa nem üres. A kivonat elemei a meglévő tartalom mellé kerülnek.");
      }
    } catch (error) {
      errors.push(`A cél Google Drive mappa nem érhető el: ${getRegistryExtractErrorMessage(error)}`);
    }
  }

  const documents = collectSelectedRegistryExtractDocumentsForPreview(errors);

  if (documents.documents.length === 0) {
    errors.push("Nincs másolható dokumentum a kijelölt sorok között.");
  }

  return {
    ok: errors.length === 0,
    targetFolderId,
    targetFolderName,
    targetFolderIsEmpty,
    selectedRowCount: documents.selectedRowCount,
    documentCount: documents.documents.length,
    skippedCount: documents.skippedRows.length,
    skippedRows: documents.skippedRows,
    warnings,
    errors,
  };
}

function collectSelectedRegistryExtractDocumentsForPreview(
  errors: string[],
): {
  selectedRowCount: number;
  documents: RegistryExtractDocument[];
  skippedRows: RegistryExtractSkippedRow[];
} {
  try {
    return collectSelectedRegistryExtractDocuments();
  } catch (error) {
    errors.push(getRegistryExtractErrorMessage(error));

    return {
      selectedRowCount: 0,
      documents: [],
      skippedRows: [],
    };
  }
}

function collectSelectedRegistryExtractDocuments(): {
  selectedRowCount: number;
  documents: RegistryExtractDocument[];
  skippedRows: RegistryExtractSkippedRow[];
} {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const registrySheet = spreadsheet.getSheetByName(REGISTRY_SHEET_NAME);
  const activeSheet = spreadsheet.getActiveSheet();

  if (registrySheet === null) {
    throw new Error(`Missing sheet: ${REGISTRY_SHEET_NAME}`);
  }

  if (activeSheet.getSheetId() !== registrySheet.getSheetId()) {
    throw new Error(`A kijelölésnek a ${REGISTRY_SHEET_NAME} munkalapon kell lennie.`);
  }

  const rowNumbers = getSelectedRegistryExtractRowNumbers(registrySheet);
  const documents: RegistryExtractDocument[] = [];
  const skippedRows: RegistryExtractSkippedRow[] = [];

  for (const rowNumber of rowNumbers) {
    const rowRange = registrySheet.getRange(rowNumber, 1, 1, REGISTRY_HEADERS.length);
    const row = rowRange.getValues()[0];
    const displayRow = rowRange.getDisplayValues()[0];
    const registryNumber = String(row[SEQ_COLUMN - 1] ?? "").trim();
    const partner = String(row[PARTNER_COLUMN - 1] ?? "").trim();
    const type = String(row[TYPE_COLUMN - 1] ?? "").trim();
    const driveFileId = String(row[GOOGLE_DRIVE_ID_COLUMN - 1] ?? "").trim();
    const missingFields = [
      registryNumber === "" ? "seq" : "",
      driveFileId === "" ? "googleDriveId" : "",
    ].filter((field) => field !== "");

    if (missingFields.length > 0) {
      skippedRows.push({
        rowNumber,
        reason: `Hiányzó kötelező mező: ${missingFields.join(", ")}`,
      });
      continue;
    }

    documents.push({
      rowNumber,
      registryNumber,
      partner,
      type,
      driveFileId,
      originalFileName: getRegistryExtractOriginalFileName(row[META_COLUMN - 1]),
      displayValues: displayRow,
    });
  }

  return {
    selectedRowCount: rowNumbers.length,
    documents,
    skippedRows,
  };
}

function getSelectedRegistryExtractRowNumbers(
  registrySheet: GoogleAppsScript.Spreadsheet.Sheet,
): number[] {
  const rangeList = registrySheet.getActiveRangeList();
  const ranges = rangeList === null
    ? [registrySheet.getActiveRange()]
    : rangeList.getRanges();
  const lastRow = registrySheet.getLastRow();
  const rowNumbers = new Set<number>();

  for (const range of ranges) {
    if (range === null) {
      continue;
    }

    const firstRow = Math.max(range.getRow(), FIRST_DATA_ROW);
    const lastSelectedRow = Math.min(
      range.getRow() + range.getNumRows() - 1,
      lastRow,
    );

    for (let rowNumber = firstRow; rowNumber <= lastSelectedRow; rowNumber += 1) {
      rowNumbers.add(rowNumber);
    }
  }

  return [...rowNumbers].sort((a, b) => a - b);
}

function createRegistryExtractSpreadsheet(
  targetFolder: GoogleAppsScript.Drive.Folder,
  copiedDocuments: Array<{
    document: RegistryExtractDocument;
    targetFileId: string;
    targetFileName: string;
  }>,
): GoogleAppsScript.Spreadsheet.Spreadsheet {
  const spreadsheetName = buildRegistryExtractSpreadsheetName();
  const spreadsheet = SpreadsheetApp.create(spreadsheetName);
  const spreadsheetFile = DriveApp.getFileById(spreadsheet.getId());
  const documentsSheet = spreadsheet.getSheets()[0];
  const exportColumnIndexes = getRegistryExtractExportColumnIndexes();
  const values = [
    exportColumnIndexes.map((columnIndex) => REGISTRY_HEADERS[columnIndex - 1]),
    ...copiedDocuments.map((copiedDocument, index) => (
      buildRegistryExtractDocumentsRow(
        copiedDocument.document,
        copiedDocument.targetFileId,
        exportColumnIndexes,
      )
    )),
  ];

  documentsSheet.setName(DOCUMENTS_SHEET_NAME);
  documentsSheet
    .getRange(1, 1, values.length, exportColumnIndexes.length)
    .setValues(values);
  documentsSheet.setFrozenRows(1);
  documentsSheet.autoResizeColumns(1, exportColumnIndexes.length);
  spreadsheetFile.moveTo(targetFolder);

  return spreadsheet;
}

function buildRegistryExtractDocumentsRow(
  document: RegistryExtractDocument,
  copiedFileId: string,
  exportColumnIndexes: number[],
): string[] {
  return exportColumnIndexes.map((columnIndex) => {
    if (columnIndex === VIEW_COLUMN) {
      return buildRegistryExtractViewFormula(copiedFileId);
    }

    return document.displayValues[columnIndex - 1] ?? "";
  });
}

function getRegistryExtractExportColumnIndexes(): number[] {
  const excludedColumns = new Set<number>([...REGISTRY_EXTRACT_EXCLUDED_COLUMNS]);

  return REGISTRY_HEADERS
    .map((_, index) => index + 1)
    .filter((columnIndex) => !excludedColumns.has(columnIndex));
}

function buildRegistryExtractViewFormula(fileId: string): string {
  return `=HYPERLINK("https://drive.google.com/open?id=${fileId}"; "🔍")`;
}

function buildRegistryExtractSpreadsheetName(): string {
  return `Iktatói kivonat ${Utilities.formatDate(
    new Date(),
    Session.getScriptTimeZone(),
    "yyyyMMdd-HHmmss",
  )}`;
}

function buildRegistryExtractTargetFileName(
  document: RegistryExtractDocument,
  sourceFileName: string,
): string {
  const originalFileName = document.originalFileName === ""
    ? stripRegistryExtractRegistryPrefixFromFileName(sourceFileName)
    : document.originalFileName;
  const parts = [
    sanitizeRegistryExtractFileNamePart(document.partner),
    sanitizeRegistryExtractFileNamePart(document.registryNumber),
    sanitizeRegistryExtractFileNamePart(document.type),
    sanitizeRegistryExtractOriginalFileName(originalFileName),
  ].filter((part) => part !== "");

  return parts.join("_");
}

function stripRegistryExtractRegistryPrefixFromFileName(fileName: string): string {
  return fileName.replace(/^R\d+_/, "").trim();
}

function getRegistryExtractOriginalFileName(metaValue: unknown): string {
  try {
    const metadata = JSON.parse(String(metaValue ?? "")) as {
      attachmentFileName?: unknown;
    };

    return String(metadata.attachmentFileName ?? "").trim();
  } catch (error) {
    console.warn(`${REGISTRY_EXTRACT_LOG_PREFIX} could not parse metadata`, { error });

    return "";
  }
}

function sanitizeRegistryExtractOriginalFileName(fileName: string): string {
  const trimmedFileName = fileName.trim();
  const extensionMatch = trimmedFileName.match(/(\.[A-Za-z0-9]{1,12})$/);

  if (extensionMatch === null) {
    return sanitizeRegistryExtractFileNamePart(trimmedFileName);
  }

  const extension = extensionMatch[1].toLowerCase();
  const baseName = trimmedFileName.slice(0, -extension.length);
  const sanitizedBaseName = sanitizeRegistryExtractFileNamePart(baseName);

  return sanitizedBaseName === "" ? extension.slice(1) : `${sanitizedBaseName}${extension}`;
}

function sanitizeRegistryExtractFileNamePart(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_ .-]+|[_ .-]+$/g, "");
}

function isRegistryExtractDriveFolderEmpty(
  folder: GoogleAppsScript.Drive.Folder,
): boolean {
  return !folder.getFiles().hasNext() && !folder.getFolders().hasNext();
}

function runRegistryExtractOperation(
  operationName: string,
  operation: () => RegistryExtractPreview,
  targetFolderInput: string,
): RegistryExtractPreview {
  try {
    return operation();
  } catch (error) {
    const message = getRegistryExtractErrorMessage(error);

    console.error(`${REGISTRY_EXTRACT_LOG_PREFIX} ${operationName} failed`, {
      targetFolderInput,
      error,
    });

    return {
      ok: false,
      targetFolderId: parseDriveFolderId(targetFolderInput),
      targetFolderName: "",
      targetFolderIsEmpty: false,
      selectedRowCount: 0,
      documentCount: 0,
      skippedCount: 0,
      skippedRows: [],
      warnings: [],
      errors: [`${operationName} hiba: ${message}`],
    };
  }
}

function updateRegistryExtractProgress(
  progressId: string,
  progress: RegistryExtractProgress,
): void {
  const cacheKey = buildRegistryExtractProgressCacheKey(progressId);

  if (cacheKey === "") {
    return;
  }

  CacheService
    .getUserCache()
    .put(cacheKey, JSON.stringify(progress), REGISTRY_EXTRACT_PROGRESS_TTL_SECONDS);
}

function buildRegistryExtractProgressCacheKey(progressId: string): string {
  const normalizedProgressId = String(progressId ?? "").trim();

  if (!/^[A-Za-z0-9_-]{8,80}$/.test(normalizedProgressId)) {
    return "";
  }

  return `${REGISTRY_EXTRACT_PROGRESS_CACHE_PREFIX}${normalizedProgressId}`;
}

function buildEmptyRegistryExtractProgress(progressId: string): RegistryExtractProgress {
  return {
    id: String(progressId ?? ""),
    status: "idle",
    totalCount: 0,
    processedCount: 0,
    copiedCount: 0,
    errorCount: 0,
    currentRegistryNumber: "",
    message: "",
  };
}

function getRegistryExtractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
