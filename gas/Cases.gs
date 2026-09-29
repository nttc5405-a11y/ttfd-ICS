/**
 * 首頁：建立案件、進入既有案件。
 * 對應 doPost 的 action：createCase、enterCase。
 */

var CASE_CATEGORIES = ['山域', '水域', '火警', '化災'];

/**
 * action: createCase
 * body: { action:'createCase', category, name, view_code, admin_code, operator_name }
 * 成功直接核發 admin token（建立者即為第一個管理者）。
 */
function handleCreateCase_(body) {
  var category = body.category;
  var name = String(body.name || '').trim();
  var viewCode = String(body.view_code || '');
  var adminCode = String(body.admin_code || '');
  var operatorName = String(body.operator_name || '').trim();

  if (CASE_CATEGORIES.indexOf(category) === -1) {
    return { ok: false, error: '案件類別不正確，需為山域/水域/火警/化災之一' };
  }
  if (!name) {
    return { ok: false, error: '請輸入案件名稱' };
  }
  if (!viewCode || !adminCode) {
    return { ok: false, error: '請設定檢視碼與管理碼' };
  }
  if (viewCode === adminCode) {
    return { ok: false, error: '檢視碼與管理碼不能相同' };
  }
  if (!operatorName) {
    return { ok: false, error: '請輸入建立人姓名' };
  }

  var salt = getSalt_();
  var viewHash = hashCode_(viewCode, salt);
  var adminHash = hashCode_(adminCode, salt);

  return withLock_(function () {
    var cases = sheetToObjects_(getSheet_('Cases'));
    var collision = cases.some(function (c) {
      return c.view_hash === viewHash || c.view_hash === adminHash ||
        c.admin_hash === viewHash || c.admin_hash === adminHash;
    });
    if (collision) {
      return { ok: false, error: '這組驗證碼已被其他案件使用，請換一組檢視碼或管理碼' };
    }

    var caseId = newId_();
    var row = {
      case_id: caseId,
      category: category,
      name: name,
      status: '進行中',
      created_at: nowIso_(),
      closed_at: '',
      view_hash: viewHash,
      admin_hash: adminHash,
      version: 1
    };
    appendRow_(getSheet_('Cases'), SHEET_SCHEMAS.Cases, row);
    appendEventLog_(caseId, 'create_case', caseId, name, operatorName);

    // 依案件類別，把 Checklists 範本複製一份到 CaseChecklist（範本本身在試算表直接編輯）
    var checklistSheet = getSheet_('CaseChecklist');
    var templates = sheetToObjects_(getSheet_('Checklists')).filter(function (t) {
      return t.category === category;
    });
    templates.forEach(function (t) {
      appendRow_(checklistSheet, SHEET_SCHEMAS.CaseChecklist, {
        case_id: caseId,
        item: t.item,
        done: 'FALSE',
        done_by: '',
        done_at: ''
      });
    });

    var token = issueToken_(caseId, 'admin', operatorName);
    return {
      ok: true,
      role: 'admin',
      token: token,
      case: {
        case_id: caseId,
        category: category,
        name: name,
        status: row.status,
        version: row.version
      }
    };
  });
}

/**
 * action: enterCase
 * body: { action:'enterCase', code, operator_name, case_id }
 * case_id 是可選的：前端現在會先讓使用者從案件清單選一個案件（見 listCases），選好之後帶著
 * case_id 送代碼，這裡就只比對那一個案件；case_id 留空則沿用舊行為，在所有案件裡用代碼找。
 * 若比對到的是管理碼但沒帶 operator_name，回傳 need_operator_name:true，
 * 讓前端補問操作者姓名後再送一次。
 */
function handleEnterCase_(body) {
  var code = String(body.code || '');
  var operatorName = String(body.operator_name || '').trim();
  var caseIdHint = String(body.case_id || '').trim();

  if (!code) {
    return { ok: false, error: '請輸入驗證碼' };
  }

  var match;
  if (caseIdHint) {
    var caseRow = findCaseById_(caseIdHint);
    if (!caseRow) return { ok: false, error: '找不到此案件' };
    var salt = getSalt_();
    var hashed = hashCode_(code, salt);
    var role = hashed === caseRow.admin_hash ? 'admin' : (hashed === caseRow.view_hash ? 'view' : null);
    if (!role) return { ok: false, error: '驗證碼錯誤' };
    match = { caseRow: caseRow, role: role };
  } else {
    match = findCaseAndRoleByCode_(code);
    if (!match) return { ok: false, error: '驗證碼錯誤或案件不存在' };
  }

  var denyReason = checkCaseAccessAllowed_(match.caseRow.case_id, match.role);
  if (denyReason) {
    return { ok: false, error: denyReason };
  }

  if (match.role === 'admin' && !operatorName) {
    return { ok: false, need_operator_name: true, error: '請輸入操作者姓名' };
  }

  var token = issueToken_(match.caseRow.case_id, match.role, operatorName);
  return {
    ok: true,
    role: match.role,
    token: token,
    case: {
      case_id: match.caseRow.case_id,
      category: match.caseRow.category,
      name: match.caseRow.name,
      status: match.caseRow.status,
      version: match.caseRow.version
    }
  };
}

/**
 * action: listCases — 首頁「進入既有案件」用，公開列出案件名稱給使用者選（不需要 token，
 * 因為選案件本身不算存取案件內容，真正要看資料還是要輸入正確的驗證碼）。
 * 只回傳名稱、類別、狀態這些非敏感欄位，不含 hash；case_view_enabled 關掉的案件不列出
 * （總開關本來就是要把案件藏起來，連清單都不該看到）。
 * body: { action:'listCases' }
 */
function handleListCases_() {
  var cases = sheetToObjects_(getSheet_('Cases'))
    .filter(function (c) { return getSettingBool_(c.case_id, 'case_view_enabled', true); })
    .map(function (c) {
      return { case_id: c.case_id, name: c.name, category: c.category, status: c.status, created_at: c.created_at };
    });

  cases.sort(function (a, b) {
    if (a.status !== b.status) return a.status === '進行中' ? -1 : 1;
    return a.created_at < b.created_at ? 1 : -1; // 同狀態內新案件在前
  });

  return { ok: true, cases: cases };
}

/**
 * action: closeCase（結案）
 * body: { action:'closeCase', token, case_id, force }
 * 狀態規則：場地全部撤收才可結案；force:true 可以強制結案（不管場地狀態）。
 * 結案後案件變唯讀，之後所有 admin 寫入動作都會被 requireAuth_ 擋下。
 */
function handleCloseCase_(body) {
  var caseId = body.case_id;
  var auth = requireAuth_(body.token, 'admin', caseId);
  var force = !!body.force;

  var caseRow = findCaseById_(caseId);
  if (!caseRow) return { ok: false, error: '找不到此案件' };
  if (caseRow.status === '結案') return { ok: false, error: '此案件已經結案過了' };

  var openSiteCount = sheetToObjects_(getSheet_('Sites')).filter(function (s) {
    return s.case_id === caseId && s.status === '開設';
  }).length;

  if (openSiteCount > 0 && !force) {
    return {
      ok: false,
      need_confirm: true,
      error: '還有 ' + openSiteCount + ' 個場地尚未撤收，確定要強制結案嗎？'
    };
  }

  return withLock_(function () {
    var closedAt = nowIso_();
    updateRow_('Cases', function (r) { return r.case_id === caseId; }, {
      status: '結案', closed_at: closedAt, version: (Number(caseRow.version) || 1) + 1
    });
    appendEventLog_(caseId, 'close_case', caseId, caseRow.name, auth.operatorName);
    return { ok: true, closed_at: closedAt };
  });
}

/**
 * 依代碼在所有案件裡找出對應的案件與角色（admin_hash 優先於 view_hash 比對，
 * 但實務上兩者不會撞在一起，因為 createCase 建立時已擋掉重複代碼）。
 */
function findCaseAndRoleByCode_(code) {
  var salt = getSalt_();
  var hashed = hashCode_(code, salt);
  var cases = sheetToObjects_(getSheet_('Cases'));
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    if (hashed === c.admin_hash) return { caseRow: c, role: 'admin' };
    if (hashed === c.view_hash) return { caseRow: c, role: 'view' };
  }
  return null;
}
