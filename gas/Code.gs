/**
 * 案件管制看板 - GAS Web App 入口。
 * 前端一律以 POST 呼叫（body 為 JSON，含 action 欄位）；
 * doGet 只提供 ?action=ping 健康檢查，方便直接用瀏覽器測試網址是否部署成功。
 *
 * 之後階段（首頁、檢核表、ICS 看板…）的新 action，都在 doPost 的 switch 裡加 case，
 * 實際邏輯寫在對應的檔案（例如 Cases.gs、Sites.gs），Code.gs 只負責路由。
 */

function doGet(e) {
  var action = e && e.parameter && e.parameter.action;
  if (action === 'ping') {
    return jsonResponse_({ ok: true, time: nowIso_(), tz: 'Asia/Taipei' });
  }
  return jsonResponse_({ ok: false, error: '請使用 POST 呼叫此 API（僅 ping 支援 GET，供健康檢查）' });
}

function doPost(e) {
  var body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonResponse_({ ok: false, error: '請求格式錯誤，需為 JSON' });
  }

  var action = body.action;
  try {
    switch (action) {
      case 'ping':
        return jsonResponse_({ ok: true, time: nowIso_(), tz: 'Asia/Taipei' });
      case 'verify':
        return jsonResponse_(handleVerify_(body));
      case 'checkToken':
        return jsonResponse_(handleCheckToken_(body));
      case 'createCase':
        return jsonResponse_(handleCreateCase_(body));
      case 'enterCase':
        return jsonResponse_(handleEnterCase_(body));
      case 'listCases':
        return jsonResponse_(handleListCases_());
      case 'getHome':
        return jsonResponse_(handleGetHome_(body));
      case 'getCaseChecklist':
        return jsonResponse_(handleGetCaseChecklist_(body));
      case 'toggleChecklistItem':
        return jsonResponse_(handleToggleChecklistItem_(body));
      case 'getPersonnel':
        return jsonResponse_(handleGetPersonnel_(body));
      case 'checkinPersonnel':
        return jsonResponse_(handleCheckinPersonnel_(body));
      case 'checkinPersonnelBatch':
        return jsonResponse_(handleCheckinPersonnelBatch_(body));
      case 'getIcsBoard':
        return jsonResponse_(handleGetIcsBoard_(body));
      case 'createSite':
        return jsonResponse_(handleCreateSite_(body));
      case 'closeSite':
        return jsonResponse_(handleCloseSite_(body));
      case 'createTask':
        return jsonResponse_(handleCreateTask_(body));
      case 'updateTaskMembers':
        return jsonResponse_(handleUpdateTaskMembers_(body));
      case 'endTask':
        return jsonResponse_(handleEndTask_(body));
      case 'createReport':
        return jsonResponse_(handleCreateReport_(body));
      case 'getWorkLog':
        return jsonResponse_(handleGetWorkLog_(body));
      case 'getReport':
        return jsonResponse_(handleGetReport_(body));
      case 'getDailyDeployment':
        return jsonResponse_(handleGetDailyDeployment_(body));
      case 'getCaseSettings':
        return jsonResponse_(handleGetCaseSettings_(body));
      case 'updateCaseSettings':
        return jsonResponse_(handleUpdateCaseSettings_(body));
      case 'closeCase':
        return jsonResponse_(handleCloseCase_(body));
      case 'updateCaseTimes':
        return jsonResponse_(handleUpdateCaseTimes_(body));
      case 'uploadMap':
        return jsonResponse_(handleUploadMap_(body));
      case 'getMaps':
        return jsonResponse_(handleGetMaps_(body));
      case 'getMapImage':
        return jsonResponse_(handleGetMapImage_(body));
      default:
        return jsonResponse_({ ok: false, error: '未知的 action：' + action });
    }
  } catch (err) {
    return jsonResponse_({ ok: false, error: '伺服器錯誤：' + err.message });
  }
}

/**
 * action: verify — 用檢視碼或管理碼交換 token。
 * body: { action:'verify', case_id, code }
 * 回傳：{ ok, role:'view'|'admin', token, case:{...} }
 */
function handleVerify_(body) {
  var caseId = body.case_id;
  var code = body.code;
  if (!caseId || !code) {
    return { ok: false, error: '缺少 case_id 或 code' };
  }

  var caseRow = findCaseById_(caseId);
  if (!caseRow) {
    return { ok: false, error: '找不到此案件' };
  }

  var salt = getSalt_();
  var hashed = hashCode_(code, salt);

  var role = null;
  if (hashed === caseRow.admin_hash) {
    role = 'admin';
  } else if (hashed === caseRow.view_hash) {
    role = 'view';
  }

  if (!role) {
    return { ok: false, error: '驗證碼錯誤' };
  }

  var denyReason = checkCaseAccessAllowed_(caseId, role);
  if (denyReason) {
    return { ok: false, error: denyReason };
  }

  var token = issueToken_(caseId, role);
  return {
    ok: true,
    role: role,
    token: token,
    case: {
      case_id: caseRow.case_id,
      category: caseRow.category,
      name: caseRow.name,
      status: caseRow.status,
      version: caseRow.version
    }
  };
}

/**
 * action: checkToken — 前端可用來確認手上的 token 是否仍然有效（例如重新整理頁面後）。
 * body: { action:'checkToken', token }
 */
function handleCheckToken_(body) {
  var info = validateToken_(body.token);
  if (!info) {
    return { ok: false, error: 'token 無效或已過期' };
  }
  return { ok: true, case_id: info.caseId, role: info.role, operator_name: info.operatorName || '' };
}
