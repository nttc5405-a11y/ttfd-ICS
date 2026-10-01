/**
 * 刪除案件（含所有關聯資料）。
 *
 * 兩種用法：
 *   1. 【推薦，日常用】試算表上方選單「案件管理 → 刪除「🗑刪除案件」分頁選擇的案件」，
 *      點進「🗑刪除案件」分頁、下拉選單選一個案件，再從選單執行刪除，會跳確認視窗。
 *      這個分頁第一次要先手動跑一次 setupCaseDeleteTool() 才會出現，之後就一直在、不用重設。
 *   2. 【批次用，适合一次清多筆】Apps Script 編輯器手動執行 devDeleteCases()，照函式裡的
 *      說明把要刪除的 case_id 填進陣列再執行，一次可以刪多筆。
 *
 * 不管哪種用法，都是真的永久刪除（試算表沒有回收桶等級的救援機制），Drive 圖資資料夾會丟進
 * 垃圾桶（可從 Drive 垃圾桶復原，相對安全），其他資料刪了就是刪了，執行前務必看清楚案件名稱。
 *
 * 會清掉的資料：Cases、Settings（該案件的個別設定）、CaseChecklist、Personnel、Sites、Tasks、
 * TaskMembers（透過 task_id 對應，這張表本身沒有 case_id 欄位）、Maps、EventLog、Marquee、Reports。
 */

var DELETE_TOOL_SHEET_NAME = '🗑刪除案件';
var CASCADE_SHEETS_WITH_CASE_ID = ['Cases', 'Settings', 'CaseChecklist', 'Personnel', 'Sites', 'Tasks', 'Maps', 'EventLog', 'Marquee', 'Reports'];

/**
 * 試算表一打開就會自動執行（Apps Script 的 onOpen 簡單觸發），負責把「案件管理」選單
 * 加到試算表上方選單列。如果選單沒出現，重新整理試算表頁面即可（觸發要等頁面重新載入）。
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('案件管理')
    .addItem('刪除「🗑刪除案件」分頁選擇的案件', 'deleteCaseFromDropdown')
    .addToUi();
}

/**
 * 手動執行一次：建立「🗑刪除案件」分頁（下拉選單＋說明文字）。可重複執行，
 * 會重設這個分頁的內容跟公式，不會動到 Cases 等其他工作表的任何資料。
 */
function setupCaseDeleteTool() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(DELETE_TOOL_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(DELETE_TOOL_SHEET_NAME);
  sheet.clear();
  sheet.clearFormats();

  sheet.getRange('A1').setValue('選擇要刪除的案件（會連同所有關聯資料一起永久刪除，無法復原！）')
    .setFontWeight('bold').setFontColor('#c62828');
  sheet.getRange('A2').setValue('案件：');
  sheet.getRange('B2').setValue('');
  sheet.getRange('A3').setValue('← 選好之後，點上方選單「案件管理」→「刪除「🗑刪除案件」分頁選擇的案件」，會先跳確認視窗再真的刪除。');
  sheet.getRange('A3').setFontColor('#757575');
  sheet.getRange('A4').setValue('如果上方沒有「案件管理」選單，重新整理這個試算表的網頁分頁再看一次。');
  sheet.getRange('A4').setFontColor('#757575');

  // D 欄：下拉選單的資料來源（案件顯示文字，名稱＋類別＋狀態＋建立時間，避免同名案件選錯）。
  sheet.getRange('D1').setValue('（下拉選單資料來源，不要手動編輯）');
  sheet.getRange('D2').setFormula(
    '=ARRAYFORMULA(IF(Cases!A2:A="","",' +
    'Cases!C2:C&"（"&Cases!B2:B&"・"&Cases!D2:D&"・建立於"&LEFT(SUBSTITUTE(Cases!E2:E,"T"," "),16)&"）"))'
  );

  // C 欄：把 B2 選到的顯示文字反查回真正的 case_id（刪除函式讀這一格，不是讀 B2 的文字本身）。
  sheet.getRange('C1').setValue('（對應的 case_id，不要手動編輯）');
  sheet.getRange('C2').setFormula('=IFERROR(INDEX(Cases!A:A, MATCH(B2, D:D, 0)), "")');

  var rule = SpreadsheetApp.newDataValidation()
    .requireValueInRange(sheet.getRange('D2:D1000'), true)
    .setAllowInvalid(false)
    .build();
  sheet.getRange('B2').setDataValidation(rule);

  sheet.setColumnWidth(1, 420);
  sheet.setColumnWidth(2, 320);
  sheet.hideColumns(3, 2); // 隱藏 C、D 兩欄，使用者只需要看到 A、B

  Logger.log('已建立「' + DELETE_TOOL_SHEET_NAME + '」分頁。切過去那個分頁，B2 選一個案件，' +
    '再從上方「案件管理」選單執行刪除。如果選單沒出現，重新整理試算表頁面。');
}

/**
 * 選單動作：讀「🗑刪除案件」分頁 B2 選到的案件，跳確認視窗，確認後執行刪除。
 */
function deleteCaseFromDropdown() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActive().getSheetByName(DELETE_TOOL_SHEET_NAME);
  if (!sheet) {
    ui.alert('找不到「' + DELETE_TOOL_SHEET_NAME + '」分頁，請先在 Apps Script 編輯器手動執行一次 setupCaseDeleteTool()。');
    return;
  }

  var caseId = String(sheet.getRange('C2').getValue() || '').trim();
  if (!caseId) {
    ui.alert('請先到「' + DELETE_TOOL_SHEET_NAME + '」分頁的 B2 選一個要刪除的案件。');
    return;
  }

  var caseRow = findCaseById_(caseId);
  if (!caseRow) {
    ui.alert('找不到這個案件（可能剛好被刪過了），請重新整理頁面、重新選一次。');
    return;
  }

  var resp = ui.alert(
    '確定要刪除「' + caseRow.name + '」嗎？',
    '這個動作無法復原！會連同這個案件的場地、任務、人員報到、檢核表、狀況回報、圖資等所有關聯資料一起刪除。',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  var result = withLock_(function () { return deleteCaseCascade_(caseId, true); });

  sheet.getRange('B2').clearContent();
  ui.alert(
    '已刪除「' + result.name + '」，共刪除 ' + result.total_deleted + ' 列資料。' +
    (result.drive_note ? '\n' + result.drive_note : '')
  );
}

/**
 * 手動執行：真正刪除 caseIdsToDelete 陣列裡列出的案件與所有關聯資料。一次可以刪多筆，
 * 適合清一整批測試案件；單筆刪除用「🗑刪除案件」分頁＋選單比較快，不用來 Apps Script 編輯器。
 * ⚠️ 這個動作無法復原，執行前務必再三確認陣列裡的 case_id 都是你真的要刪的。
 */
function devDeleteCases() {
  // ↓↓↓ 把要刪除的 case_id 貼在這裡，一個字串一行，先執行 devListCasesForCleanup() 對照 ↓↓↓
  var caseIdsToDelete = [
    // '18a073c8-a5c4-46c7-bf3c-285f76f31fe3', // 範例：【測試】批次報到驗收用
  ];
  var alsoTrashDriveFolder = true;
  // ↑↑↑ 改完上面兩個變數，確認無誤後再執行 ↑↑↑

  if (caseIdsToDelete.length === 0) {
    Logger.log('caseIdsToDelete 是空陣列，沒有刪除任何東西。');
    Logger.log('請先執行 devListCasesForCleanup() 查看案件清單，把要刪除的 case_id 貼進這個函式的陣列裡再重新執行。');
    return;
  }

  withLock_(function () {
    caseIdsToDelete.forEach(function (caseId) {
      var result = deleteCaseCascade_(caseId, alsoTrashDriveFolder);
      Logger.log('已刪除「' + result.name + '」（' + result.case_id + '），共 ' + result.total_deleted +
        ' 列資料（含 TaskMembers ' + result.task_members_deleted + ' 列）。');
      if (result.drive_note) Logger.log('  → ' + result.drive_note);
    });
  });

  Logger.log('全部完成。');
}

/**
 * 手動執行：列出所有案件方便對照，找出要刪除的 case_id（devDeleteCases 批次刪除用；
 * 「🗑刪除案件」分頁走下拉選單不需要用到這個）。
 */
function devListCasesForCleanup() {
  var cases = sheetToObjects_(getSheet_('Cases'));
  if (cases.length === 0) {
    Logger.log('目前沒有任何案件。');
    return;
  }
  cases.forEach(function (c, i) {
    Logger.log((i + 1) + '. [' + c.status + '] ' + c.name + '（' + c.category + '，建立於 ' + c.created_at + '）');
    Logger.log('   case_id = ' + c.case_id);
  });
  Logger.log('共 ' + cases.length + ' 筆。要刪除哪幾筆，把對應的 case_id 複製貼進 devDeleteCases() 函式裡的');
  Logger.log('caseIdsToDelete 陣列，確認清單無誤後再執行 devDeleteCases()。');
}

/**
 * 實際執行一個案件的刪除：清掉所有關聯工作表的資料列，並視需要把 Drive 圖資資料夾丟進垃圾桶。
 * devDeleteCases()（批次）、deleteCaseFromDropdown()（選單單筆）共用這個函式，邏輯只寫一份。
 * 回傳 { case_id, name, total_deleted, task_members_deleted, drive_note }。
 */
function deleteCaseCascade_(caseId, alsoTrashDriveFolder) {
  var caseRow = findCaseById_(caseId);
  var caseName = caseRow ? caseRow.name : '（找不到，可能已經刪過或 case_id 打錯）';

  // TaskMembers 沒有 case_id 欄位，要先收集這個案件底下所有 task_id 才能對應刪除
  var taskIds = sheetToObjects_(getSheet_('Tasks'))
    .filter(function (t) { return t.case_id === caseId; })
    .map(function (t) { return t.task_id; });

  var taskMembersDeleted = deleteRowsWhere_('TaskMembers', function (r) {
    return taskIds.indexOf(r.task_id) !== -1;
  });

  var totalDeleted = taskMembersDeleted;
  CASCADE_SHEETS_WITH_CASE_ID.forEach(function (sheetName) {
    totalDeleted += deleteRowsWhere_(sheetName, function (r) { return r.case_id === caseId; });
  });

  var driveNote = '';
  if (alsoTrashDriveFolder) {
    try {
      var root = getOrCreateMapsRootFolder_();
      var it = root.getFoldersByName(caseId);
      if (it.hasNext()) {
        it.next().setTrashed(true);
        driveNote = '這個案件的 Drive 圖資資料夾已丟進垃圾桶（Drive 垃圾桶可復原）。';
      }
    } catch (e) {
      driveNote = 'Drive 圖資資料夾處理失敗：' + e.message + '（不影響試算表資料已刪除的結果）。';
    }
  }

  return {
    case_id: caseId,
    name: caseName,
    total_deleted: totalDeleted,
    task_members_deleted: taskMembersDeleted,
    drive_note: driveNote
  };
}

/**
 * 刪掉 sheetName 裡符合 predicate 的所有列，回傳刪了幾列。由後往前刪，避免刪除中途行號跑掉。
 */
function deleteRowsWhere_(sheetName, predicate) {
  var sheet = getSheet_(sheetName);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return 0;

  var headers = values[0];
  var rowsToDelete = [];
  for (var i = 1; i < values.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) obj[headers[j]] = values[i][j];
    if (predicate(obj)) rowsToDelete.push(i + 1); // 試算表列號從 1 開始，第 1 列是標題
  }

  rowsToDelete.sort(function (a, b) { return b - a; }); // 由大到小，先刪下面的列才不會影響上面列號
  rowsToDelete.forEach(function (rowNum) { sheet.deleteRow(rowNum); });
  return rowsToDelete.length;
}
