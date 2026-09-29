/**
 * 圖資上傳與檢視。
 *
 * 存放方式（見 SPEC 技術注意事項）：前端先壓縮（長邊約 1600px、JPEG）再以 base64 送到這裡；
 * 圖片存進 Drive 資料夾（不開共用權限），試算表 Maps 只記 drive_id；檢視端一律透過
 * getMapImage 這個 action 經 GAS 取圖（GAS 用部署者身分讀取 Drive 檔案），
 * 前端永遠不會拿到 Drive 的直接連結，避免共用權限外洩的問題。
 */

/**
 * action: uploadMap
 * body: { action:'uploadMap', token, case_id, site_id, name, image_base64, mime_type }
 * site_id 留空＝全案圖資（不屬於特定場地）。
 */
function handleUploadMap_(body) {
  var caseId = body.case_id;
  var auth = requireAuth_(body.token, 'admin', caseId);

  var name = String(body.name || '').trim();
  var siteId = String(body.site_id || '').trim();
  var base64 = body.image_base64;
  var mimeType = body.mime_type || 'image/jpeg';

  if (!name) return { ok: false, error: '請輸入圖資名稱' };
  if (!base64) return { ok: false, error: '沒有收到圖片資料' };

  if (siteId) {
    var site = findSiteById_(caseId, siteId);
    if (!site) return { ok: false, error: '找不到指定的場地' };
  }

  var bytes;
  try {
    bytes = Utilities.base64Decode(base64);
  } catch (e) {
    return { ok: false, error: '圖片資料格式不正確' };
  }

  var blob = Utilities.newBlob(bytes, mimeType, name);
  var folder = getOrCreateCaseMapsFolder_(caseId);
  var file = folder.createFile(blob);

  return withLock_(function () {
    var mapId = newId_();
    appendRow_(getSheet_('Maps'), SHEET_SCHEMAS.Maps, {
      map_id: mapId,
      case_id: caseId,
      site_id: siteId,
      name: name,
      drive_id: file.getId(),
      created_at: nowIso_()
    });
    appendEventLog_(caseId, 'upload_map', mapId, name, auth.operatorName);
    return { ok: true, map_id: mapId };
  });
}

/**
 * action: getMaps — 只回傳清單（名稱、建立時間），不含圖片內容，圖片要另外呼叫 getMapImage。
 * body: { action:'getMaps', token, case_id }
 */
function handleGetMaps_(body) {
  var caseId = body.case_id;
  requireAuth_(body.token, 'view', caseId);
  var list = sheetToObjects_(getSheet_('Maps'))
    .filter(function (m) { return m.case_id === caseId; })
    .map(function (m) {
      return { map_id: m.map_id, site_id: m.site_id, name: m.name, created_at: m.created_at };
    });
  return { ok: true, maps: list };
}

/**
 * action: getMapImage — 實際讀圖片內容（base64），檢視端點開單張圖時才呼叫，避免清單 API 太肥。
 * body: { action:'getMapImage', token, case_id, map_id }
 */
function handleGetMapImage_(body) {
  var caseId = body.case_id;
  requireAuth_(body.token, 'view', caseId);
  var mapId = body.map_id;

  var maps = sheetToObjects_(getSheet_('Maps')).filter(function (m) {
    return m.case_id === caseId && m.map_id === mapId;
  });
  if (maps.length === 0) return { ok: false, error: '找不到這筆圖資' };

  var m = maps[0];
  try {
    var file = DriveApp.getFileById(m.drive_id);
    var blob = file.getBlob();
    return {
      ok: true,
      name: m.name,
      mime_type: blob.getContentType(),
      image_base64: Utilities.base64Encode(blob.getBytes())
    };
  } catch (e) {
    return { ok: false, error: '讀取圖片失敗：' + e.message };
  }
}

/**
 * 取得（沒有就建立）這個案件專用的 Drive 子資料夾，圖資都存在這裡面。
 * 所有案件共用一個母資料夾「案件管制看板-圖資」，母資料夾 ID 存在 Script Properties。
 */
function getOrCreateCaseMapsFolder_(caseId) {
  var root = getOrCreateMapsRootFolder_();
  var it = root.getFoldersByName(caseId);
  if (it.hasNext()) return it.next();
  return root.createFolder(caseId);
}

function getOrCreateMapsRootFolder_() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('MAPS_FOLDER_ID');
  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (e) {
      // 資料夾被手動刪除或移動過，掉下去重新建立一個
    }
  }
  var folder = DriveApp.createFolder('案件管制看板-圖資');
  props.setProperty('MAPS_FOLDER_ID', folder.getId());
  return folder;
}

/**
 * 手動執行一次：專門用來觸發 Google Drive 權限的授權畫面。
 *
 * 貼完 Maps.gs 之後，光是存檔或重新部署都不會自動跳出新權限的授權提示——
 * 授權只在「編輯器裡手動執行一個真的會用到該權限的函式」時才會觸發，而其他 Drive 相關函式
 * 名稱都是底線結尾（內部函式），不會出現在執行選單。跑這個函式就會跳出授權畫面，
 * 跟第 1 階段一樣的流程（選帳號→進階→前往（不安全）→允許）。
 * 授權完成後記得回「部署→管理部署作業」建一個新版本，Web App 才會真的套用新權限。
 */
function devAuthorizeDriveAccess() {
  var folder = getOrCreateMapsRootFolder_();
  Logger.log('Drive 授權成功，圖資母資料夾：' + folder.getName() + '（' + folder.getUrl() + '）');
}
