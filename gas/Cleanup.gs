/**
 * 刪除案件（含所有關聯資料）。
 *
 * 兩種用法：
 *   1. 【推薦，日常用，支援單筆或一次勾多筆】試算表「🗑刪除案件」分頁：每個案件一列、
 *      前面有勾選框，勾一個或勾多個都可以，勾完點上方選單「案件管理 → 刪除勾選的案件」，
 *      會跳確認視窗列出要刪的案件名稱，確認後才真的刪除。
 *      這個分頁第一次要先手動跑一次 setupCaseDeleteTool() 才會出現；之後案件有異動
 *      （新建、改名…）要重新整理清單，用選單「案件管理 → 重新整理待刪除清單」。
 *   2. 【進階，不想開試算表 UI 時用】Apps Script 編輯器手動執行 devDeleteCases()，照函式裡的
 *      說明把要刪除的 case_id 填進陣列再執行。效果跟方法 1 一樣，只是操作介面不同。
 *
 * 不管哪種用法，都是真的永久刪除（試算表沒有回收桶等級的救援機制），Drive 圖資資料夾會丟進
 * 垃圾桶（可從 Drive 垃圾桶復原，相對安全），其他資料刪了就是刪了，執行前務必看清楚案件名稱。
 *
 * 會清掉的資料：Cases、Settings（該案件的個別設定）、CaseChecklist、Personnel、Sites、Tasks、
 * TaskMembers（透過 task_id 對應，這張表本身沒有 case_id 欄位）、Maps、EventLog、Marquee、Reports。
 *
 * 清單用「重新整理」當下拍的快照（寫死的值，不是即時公式），勾選框跟案件的對應關係不會因為
 * Cases 工作表之後有異動而跑掉；真正刪除時是讀每一列隱藏的 case_id 欄位去比對，不是看第幾列，
 * 避免「位置對應錯誤」這種本專案出過的資料配對陷阱（見 .claude/rules 的教訓紀錄）。
 */

var DELETE_TOOL_SHEET_NAME = '🗑刪除案件';
var DELETE_LIST_FIRST_DATA_ROW = 3;
var DELETE_LIST_COLUMNS = 6; // 勾選框、名稱、類別、狀態、建立時間、case_id（隱藏）
var CASCADE_SHEETS_WITH_CASE_ID = ['Cases', 'Settings', 'CaseChecklist', 'Personnel', 'Sites', 'Tasks', 'Maps', 'EventLog', 'Marquee', 'Reports'];

/**
 * 試算表一打開就會自動執行（Apps Script 的 onOpen 簡單觸發），負責把「案件管理」選單
 * 加到試算表上方選單列。如果選單沒出現，重新整理試算表頁面即可（觸發要等頁面重新載入）。
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('案件管理')
    .addItem('重新整理待刪除清單', 'refreshCaseDeleteList')
    .addItem('刪除勾選的案件', 'deleteCheckedCases')
    .addToUi();
}

/**
 * 手動執行一次：建立「🗑刪除案件」分頁（標題、表頭、欄寬），並立刻填入目前的案件清單。
 * 可重複執行，會重設這個分頁的版面，不會動到 Cases 等其他工作表的任何資料。
 */
function setupCaseDeleteTool() {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(DELETE_TOOL_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(DELETE_TOOL_SHEET_NAME);
  sheet.clear();
  sheet.clearFormats();

  sheet.getRange('A1').setValue('勾選要刪除的案件（可以勾一筆或多筆），再用上方「案件管理」選單執行刪除。會連同所有關聯資料一起永久刪除，無法復原！')
    .setFontWeight('bold').setFontColor('#c62828');
  sheet.getRange(2, 1, 1, DELETE_LIST_COLUMNS).setValues([['刪除', '案件名稱', '類別', '狀態', '建立時間', 'case_id']]);
  sheet.getRange(2, 1, 1, DELETE_LIST_COLUMNS).setFontWeight('bold');

  sheet.setColumnWidth(1, 50);
  sheet.setColumnWidth(2, 260);
  sheet.setColumnWidth(3, 70);
  sheet.setColumnWidth(4, 70);
  sheet.setColumnWidth(5, 140);
  sheet.hideColumns(6); // case_id 欄，內部比對用，不用給使用者看

  populateCaseDeleteList_(sheet);

  Logger.log('已建立「' + DELETE_TOOL_SHEET_NAME + '」分頁並填入案件清單。切過去那個分頁，' +
    '勾選要刪除的案件，再從上方「案件管理」選單執行刪除。如果選單沒出現，重新整理試算表頁面。');
}

/**
 * 選單動作：案件有新建、改名、結案等異動後，清單可能跟現況不同步，用這個重新整理
 * （會先清空舊的勾選狀態，重新拍一份現況快照）。
 */
function refreshCaseDeleteList() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(DELETE_TOOL_SHEET_NAME);
  if (!sheet) {
    SpreadsheetApp.getUi().alert('請先在 Apps Script 編輯器手動執行一次 setupCaseDeleteTool()。');
    return;
  }
  populateCaseDeleteList_(sheet);
  SpreadsheetApp.getUi().alert('清單已更新。');
}

/**
 * 把目前所有案件寫成清單（從第 3 列開始，一案一列，含一個勾選框），寫死的值不是公式，
 * 所以之後 Cases 工作表排序或內容變動，都不會讓已經打開的這份清單跟著默默改變。
 */
function populateCaseDeleteList_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow >= DELETE_LIST_FIRST_DATA_ROW) {
    sheet.getRange(DELETE_LIST_FIRST_DATA_ROW, 1, lastRow - DELETE_LIST_FIRST_DATA_ROW + 1, DELETE_LIST_COLUMNS).clearContent();
  }

  var cases = sheetToObjects_(getSheet_('Cases'));
  cases.sort(function (a, b) { return a.created_at < b.created_at ? 1 : -1; }); // 新案件在前

  if (cases.length === 0) return;

  var rows = cases.map(function (c) {
    return [false, c.name, c.category, c.status, String(c.created_at).replace('T', ' ').substring(0, 16), c.case_id];
  });
  sheet.getRange(DELETE_LIST_FIRST_DATA_ROW, 1, rows.length, DELETE_LIST_COLUMNS).setValues(rows);

  var checkboxRule = SpreadsheetApp.newDataValidation().requireCheckbox().build();
  sheet.getRange(DELETE_LIST_FIRST_DATA_ROW, 1, rows.length, 1).setDataValidation(checkboxRule);
}

/**
 * 選單動作：讀「🗑刪除案件」分頁裡所有勾選的列，跳確認視窗列出案件名稱，確認後逐一刪除，
 * 刪完自動重新整理清單（刪掉的案件會從清單消失）。
 */
function deleteCheckedCases() {
  var ui = SpreadsheetApp.getUi();
  var sheet = SpreadsheetApp.getActive().getSheetByName(DELETE_TOOL_SHEET_NAME);
  if (!sheet) {
    ui.alert('請先在 Apps Script 編輯器手動執行一次 setupCaseDeleteTool()。');
    return;
  }

  var lastRow = sheet.getLastRow();
  if (lastRow < DELETE_LIST_FIRST_DATA_ROW) {
    ui.alert('清單是空的，請先用選單「重新整理待刪除清單」。');
    return;
  }

  var values = sheet.getRange(DELETE_LIST_FIRST_DATA_ROW, 1, lastRow - DELETE_LIST_FIRST_DATA_ROW + 1, DELETE_LIST_COLUMNS).getValues();
  var checkedRows = values.filter(function (r) { return r[0] === true; });

  if (checkedRows.length === 0) {
    ui.alert('目前沒有勾選任何案件。');
    return;
  }

  var names = checkedRows.map(function (r) { return r[1]; });
  var resp = ui.alert(
    '確定要刪除以下 ' + checkedRows.length + ' 個案件嗎？',
    names.join('\n') + '\n\n這個動作無法復原！會連同每個案件的場地、任務、人員報到、檢核表、' +
      '狀況回報、圖資等所有關聯資料一起刪除。',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  var results = withLock_(function () {
    return checkedRows.map(function (r) { return deleteCaseCascade_(r[5], true); });
  });

  var summaryLines = results.map(function (res) {
    return '「' + res.name + '」共 ' + res.total_deleted + ' 列' + (res.drive_note ? '（已處理圖資）' : '');
  });
  ui.alert('刪除完成：\n' + summaryLines.join('\n'));

  populateCaseDeleteList_(sheet);
}

/**
 * 手動執行：真正刪除 caseIdsToDelete 陣列裡列出的案件與所有關聯資料。效果跟「🗑刪除案件」
 * 分頁勾選刪除一樣，只是不開試算表 UI、直接在 Apps Script 編輯器操作時可以用這個。
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
 * 手動執行：列出所有案件方便對照，找出要刪除的 case_id（devDeleteCases 用；
 * 「🗑刪除案件」分頁走勾選不需要用到這個）。
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
 * 「🗑刪除案件」分頁的勾選刪除、devDeleteCases() 批次都共用這個函式，邏輯只寫一份。
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
