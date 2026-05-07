const ACCOUNTING_EXPORT_LOG_PREFIX = "[accounting-export]";
const ACCOUNTING_EXPORT_SIDEBAR_FILE = "accounting-export-sidebar";
const ACCOUNTING_EXPORT_SIDEBAR_TITLE = "Számlák letöltése a könyvelésnek";
const ACCOUNTING_EXPORT_PROGRESS_CACHE_PREFIX = "accounting-export-progress:";
const ACCOUNTING_EXPORT_PROGRESS_TTL_SECONDS = 21600;
const ACCOUNTING_EXPORT_REQUIRED_TYPES = [
  "Átutalásos számla",
  "Díjbekérő",
  "Kártyás számla",
  "Készpénzes számla",
  "Proforma számla",
  "Útelszámolás",
  "Sztornó számla",
  "Érvénytelenítő számla",
  "Számlával egy tekintet alá eső okirat",
  "Teljesítési igazolás",
] as const;

type AccountingExportDocument = {
  rowNumber: number;
  registryNumber: string;
  partner: string;
  type: string;
  refDate: string;
  driveFileId: string;
  originalFileName: string;
};

type AccountingExportSkippedRow = {
  rowNumber: number;
  reason: string;
};

type AccountingExportError = {
  rowNumber: number;
  registryNumber: string;
  driveFileId: string;
  message: string;
};

type AccountingExportPreview = {
  ok: boolean;
  month: string;
  monthLabel: string;
  targetFolderId: string;
  targetFolderName: string;
  targetFolderIsEmpty: boolean;
  documentCount: number;
  skippedCount: number;
  skippedRows: AccountingExportSkippedRow[];
  errors: string[];
};

type AccountingExportResult = AccountingExportPreview & {
  copiedCount: number;
  copiedFiles: Array<{
    rowNumber: number;
    registryNumber: string;
    sourceFileId: string;
    targetFileId: string;
    targetFileName: string;
  }>;
  copyErrors: AccountingExportError[];
};

type AccountingExportProgress = {
  id: string;
  status: "idle" | "running" | "blocked" | "finished";
  totalCount: number;
  processedCount: number;
  copiedCount: number;
  errorCount: number;
  currentRegistryNumber: string;
  message: string;
};

function showAccountingExportSidebar(): void {
  const html = HtmlService
    .createHtmlOutputFromFile(ACCOUNTING_EXPORT_SIDEBAR_FILE)
    .setTitle(ACCOUNTING_EXPORT_SIDEBAR_TITLE);

  SpreadsheetApp.getUi().showSidebar(html);
}

function getDefaultAccountingExportMonth(): string {
  const now = new Date();
  const previousMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);

  return formatAccountingExportMonth(previousMonth);
}

function previewAccountingExport(
  month: string,
  targetFolderInput: string,
): AccountingExportPreview {
  console.log(`${ACCOUNTING_EXPORT_LOG_PREFIX} preview started`, {
    month,
    targetFolderInput,
  });

  const preview = runAccountingExportOperation(
    "preview",
    () => buildAccountingExportPreview(month, targetFolderInput),
    month,
    targetFolderInput,
  );

  console.log(`${ACCOUNTING_EXPORT_LOG_PREFIX} preview finished`, {
    month: preview.month,
    targetFolderId: preview.targetFolderId,
    documentCount: preview.documentCount,
    skippedCount: preview.skippedCount,
    targetFolderIsEmpty: preview.targetFolderIsEmpty,
    errorCount: preview.errors.length,
  });

  return preview;
}

function copyAccountingExport(
  month: string,
  targetFolderInput: string,
  progressId?: string,
): AccountingExportResult {
  const lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
    return copyAccountingExportLocked(month, targetFolderInput, progressId ?? "");
  } finally {
    lock.releaseLock();
  }
}

function copyAccountingExportLocked(
  month: string,
  targetFolderInput: string,
  progressId: string,
): AccountingExportResult {
  console.log(`${ACCOUNTING_EXPORT_LOG_PREFIX} copy started`, {
    month,
    targetFolderInput,
  });

  const preview = runAccountingExportOperation(
    "copy preview",
    () => buildAccountingExportPreview(month, targetFolderInput),
    month,
    targetFolderInput,
  );
  const result: AccountingExportResult = {
    ...preview,
    copiedCount: 0,
    copiedFiles: [],
    copyErrors: [],
  };

  if (!preview.ok) {
    updateAccountingExportProgress(progressId, {
      id: progressId,
      status: "blocked",
      totalCount: preview.documentCount,
      processedCount: 0,
      copiedCount: 0,
      errorCount: preview.errors.length,
      currentRegistryNumber: "",
      message: "A másolás nem indult el, mert az ellenőrzés hibát talált.",
    });
    console.warn(`${ACCOUNTING_EXPORT_LOG_PREFIX} copy blocked`, {
      errors: preview.errors,
      targetFolderIsEmpty: preview.targetFolderIsEmpty,
    });

    return result;
  }

  const targetFolder = DriveApp.getFolderById(preview.targetFolderId);
  const documents = collectAccountingExportDocuments(preview.month);

  updateAccountingExportProgress(progressId, {
    id: progressId,
    status: "running",
    totalCount: documents.documents.length,
    processedCount: 0,
    copiedCount: 0,
    errorCount: 0,
    currentRegistryNumber: "",
    message: "Másolás folyamatban...",
  });

  for (const document of documents.documents) {
    try {
      updateAccountingExportProgress(progressId, {
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
      const targetFileName = buildAccountingExportTargetFileName(
        document,
        preview.month,
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
      console.log(`${ACCOUNTING_EXPORT_LOG_PREFIX} copied row ${document.rowNumber}`, {
        registryNumber: document.registryNumber,
        sourceFileId: document.driveFileId,
        targetFileId: targetFile.getId(),
        targetFileName,
      });
    } catch (error) {
      const message = getAccountingExportErrorMessage(error);

      result.copyErrors.push({
        rowNumber: document.rowNumber,
        registryNumber: document.registryNumber,
        driveFileId: document.driveFileId,
        message,
      });
      console.error(`${ACCOUNTING_EXPORT_LOG_PREFIX} copy failed row ${document.rowNumber}`, {
        registryNumber: document.registryNumber,
        driveFileId: document.driveFileId,
        error,
      });
    }

    updateAccountingExportProgress(progressId, {
      id: progressId,
      status: "running",
      totalCount: documents.documents.length,
      processedCount: result.copiedCount + result.copyErrors.length,
      copiedCount: result.copiedCount,
      errorCount: result.copyErrors.length,
      currentRegistryNumber: document.registryNumber,
      message: `${result.copiedCount + result.copyErrors.length} / ${documents.documents.length} fájl feldolgozva`,
    });
  }

  updateAccountingExportProgress(progressId, {
    id: progressId,
    status: "finished",
    totalCount: documents.documents.length,
    processedCount: result.copiedCount + result.copyErrors.length,
    copiedCount: result.copiedCount,
    errorCount: result.copyErrors.length,
    currentRegistryNumber: "",
    message: "Másolás kész.",
  });

  console.log(`${ACCOUNTING_EXPORT_LOG_PREFIX} copy finished`, {
    month: result.month,
    documentCount: result.documentCount,
    copiedCount: result.copiedCount,
    skippedCount: result.skippedCount,
    copyErrorCount: result.copyErrors.length,
  });

  return result;
}

function getAccountingExportProgress(progressId: string): AccountingExportProgress {
  const cacheKey = buildAccountingExportProgressCacheKey(progressId);
  const cachedProgress = cacheKey === ""
    ? null
    : CacheService.getUserCache().get(cacheKey);

  if (cachedProgress === null) {
    return buildEmptyAccountingExportProgress(progressId);
  }

  try {
    return JSON.parse(cachedProgress) as AccountingExportProgress;
  } catch (error) {
    console.warn(`${ACCOUNTING_EXPORT_LOG_PREFIX} could not parse progress`, {
      progressId,
      error,
    });

    return buildEmptyAccountingExportProgress(progressId);
  }
}

function updateAccountingExportProgress(
  progressId: string,
  progress: AccountingExportProgress,
): void {
  const cacheKey = buildAccountingExportProgressCacheKey(progressId);

  if (cacheKey === "") {
    return;
  }

  CacheService
    .getUserCache()
    .put(cacheKey, JSON.stringify(progress), ACCOUNTING_EXPORT_PROGRESS_TTL_SECONDS);
}

function buildAccountingExportProgressCacheKey(progressId: string): string {
  const normalizedProgressId = String(progressId ?? "").trim();

  if (!/^[A-Za-z0-9_-]{8,80}$/.test(normalizedProgressId)) {
    return "";
  }

  return `${ACCOUNTING_EXPORT_PROGRESS_CACHE_PREFIX}${normalizedProgressId}`;
}

function buildEmptyAccountingExportProgress(progressId: string): AccountingExportProgress {
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

function runAccountingExportOperation(
  operationName: string,
  operation: () => AccountingExportPreview,
  month: string,
  targetFolderInput: string,
): AccountingExportPreview {
  try {
    return operation();
  } catch (error) {
    const message = getAccountingExportErrorMessage(error);

    console.error(`${ACCOUNTING_EXPORT_LOG_PREFIX} ${operationName} failed`, {
      month,
      targetFolderInput,
      error,
    });

    return {
      ok: false,
      month: normalizeAccountingExportMonth(month),
      monthLabel: buildAccountingExportMonthLabel(normalizeAccountingExportMonth(month)),
      targetFolderId: parseDriveFolderId(targetFolderInput),
      targetFolderName: "",
      targetFolderIsEmpty: false,
      documentCount: 0,
      skippedCount: 0,
      skippedRows: [],
      errors: [`${operationName} hiba: ${message}`],
    };
  }
}

function buildAccountingExportPreview(
  month: string,
  targetFolderInput: string,
): AccountingExportPreview {
  const normalizedMonth = normalizeAccountingExportMonth(month);
  const errors: string[] = [];
  let targetFolderId = "";
  let targetFolderName = "";
  let targetFolderIsEmpty = false;

  if (normalizedMonth === "") {
    errors.push("Érvénytelen hónap. YYYY-MM formátumot adj meg.");
  }

  targetFolderId = parseDriveFolderId(targetFolderInput);

  if (targetFolderId === "") {
    errors.push("Hiányzik a cél Google Drive mappa azonosítója.");
  } else {
    try {
      const targetFolder = DriveApp.getFolderById(targetFolderId);

      targetFolderName = targetFolder.getName();
      targetFolderIsEmpty = isDriveFolderEmpty(targetFolder);
    } catch (error) {
      errors.push(`A cél Google Drive mappa nem érhető el: ${getAccountingExportErrorMessage(error)}`);
    }
  }

  const documents = normalizedMonth === ""
    ? { documents: [], skippedRows: [] }
    : collectAccountingExportDocuments(normalizedMonth);

  if (targetFolderId !== "" && targetFolderName !== "" && !targetFolderIsEmpty) {
    errors.push("A cél Google Drive mappa nem üres. Válassz üres mappát a másoláshoz.");
  }

  return {
    ok: errors.length === 0,
    month: normalizedMonth,
    monthLabel: buildAccountingExportMonthLabel(normalizedMonth),
    targetFolderId,
    targetFolderName,
    targetFolderIsEmpty,
    documentCount: documents.documents.length,
    skippedCount: documents.skippedRows.length,
    skippedRows: documents.skippedRows,
    errors,
  };
}

function collectAccountingExportDocuments(month: string): {
  documents: AccountingExportDocument[];
  skippedRows: AccountingExportSkippedRow[];
} {
  const registrySheet = SpreadsheetApp
    .getActiveSpreadsheet()
    .getSheetByName(REGISTRY_SHEET_NAME);

  if (registrySheet === null) {
    throw new Error(`Missing sheet: ${REGISTRY_SHEET_NAME}`);
  }

  const lastRow = registrySheet.getLastRow();

  if (lastRow < FIRST_DATA_ROW) {
    return {
      documents: [],
      skippedRows: [],
    };
  }

  const values = registrySheet
    .getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, REGISTRY_HEADERS.length)
    .getValues();
  const documents: AccountingExportDocument[] = [];
  const skippedRows: AccountingExportSkippedRow[] = [];

  values.forEach((row, index) => {
    const rowNumber = FIRST_DATA_ROW + index;
    const type = String(row[TYPE_COLUMN - 1] ?? "").trim();

    if (!isAccountingExportDocumentType(type)) {
      return;
    }

    const refDate = normalizeAccountingExportDate(row[REF_DATE_COLUMN - 1]);

    if (refDate === "") {
      skippedRows.push({
        rowNumber,
        reason: "Hiányzó vagy érvénytelen kötelező mező: refDate",
      });
      return;
    }

    if (!isDateInAccountingExportMonth(refDate, month)) {
      return;
    }

    const registryNumber = String(row[SEQ_COLUMN - 1] ?? "").trim();
    const partner = String(row[PARTNER_COLUMN - 1] ?? "").trim();
    const driveFileId = String(row[GOOGLE_DRIVE_ID_COLUMN - 1] ?? "").trim();
    const missingFields = [
      registryNumber === "" ? "seq" : "",
      partner === "" ? "partner" : "",
      driveFileId === "" ? "googleDriveId" : "",
    ].filter((field) => field !== "");

    if (missingFields.length > 0) {
      skippedRows.push({
        rowNumber,
        reason: `Hiányzó kötelező mező: ${missingFields.join(", ")}`,
      });
      return;
    }

    documents.push({
      rowNumber,
      registryNumber,
      partner,
      type,
      refDate,
      driveFileId,
      originalFileName: getAccountingExportOriginalFileName(row[META_COLUMN - 1]),
    });
  });

  return {
    documents,
    skippedRows,
  };
}

function isAccountingExportDocumentType(type: string): boolean {
  return ACCOUNTING_EXPORT_REQUIRED_TYPES.some((requiredType) => requiredType === type);
}

function isDateInAccountingExportMonth(refDate: string, month: string): boolean {
  return refDate.startsWith(`${month}-`);
}

function normalizeAccountingExportDate(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return Utilities.formatDate(
      value,
      Session.getScriptTimeZone(),
      "yyyy-MM-dd",
    );
  }

  const dateString = String(value ?? "").trim();

  return /^\d{4}-\d{2}-\d{2}$/.test(dateString) ? dateString : "";
}

function normalizeAccountingExportMonth(month: string): string {
  const normalizedMonth = String(month ?? "").trim();

  return /^\d{4}-\d{2}$/.test(normalizedMonth) ? normalizedMonth : "";
}

function formatAccountingExportMonth(date: Date): string {
  return Utilities.formatDate(
    date,
    Session.getScriptTimeZone(),
    "yyyy-MM",
  );
}

function buildAccountingExportMonthLabel(month: string): string {
  return month === "" ? "" : month.replace("-", ".");
}

function isDriveFolderEmpty(folder: GoogleAppsScript.Drive.Folder): boolean {
  return !folder.getFiles().hasNext() && !folder.getFolders().hasNext();
}

function getAccountingExportOriginalFileName(metaValue: unknown): string {
  try {
    const metadata = JSON.parse(String(metaValue ?? "")) as {
      attachmentFileName?: unknown;
    };

    return String(metadata.attachmentFileName ?? "").trim();
  } catch (error) {
    console.warn(`${ACCOUNTING_EXPORT_LOG_PREFIX} could not parse metadata`, { error });

    return "";
  }
}

function buildAccountingExportTargetFileName(
  document: AccountingExportDocument,
  month: string,
  sourceFileName: string,
): string {
  const parts = [
    sanitizeAccountingExportFileNamePart(document.partner),
    sanitizeAccountingExportFileNamePart(document.registryNumber),
    sanitizeAccountingExportFileNamePart(document.type),
    sanitizeAccountingExportFileNamePart(month.replace("-", "")),
  ].filter((part) => part !== "");
  const extension = getAccountingExportFileExtension(
    document.originalFileName,
    sourceFileName,
  );

  return `${parts.join("_")}${extension}`;
}

function getAccountingExportFileExtension(
  originalFileName: string,
  sourceFileName: string,
): string {
  const originalExtension = extractAccountingExportFileExtension(originalFileName);

  if (originalExtension !== "") {
    return originalExtension;
  }

  return extractAccountingExportFileExtension(sourceFileName);
}

function extractAccountingExportFileExtension(fileName: string): string {
  const extensionMatch = fileName.trim().match(/(\.[A-Za-z0-9]{1,12})$/);

  return extensionMatch === null ? "" : extensionMatch[1].toLowerCase();
}

function sanitizeAccountingExportFileNamePart(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_ .-]+|[_ .-]+$/g, "");
}

function getAccountingExportErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
