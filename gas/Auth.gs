/**
 * 驗證碼雜湊與 token 機制。
 *
 * 存放：檢視碼／管理碼只存 SHA-256(code + salt) 雜湊值，不存明碼。
 * salt 存在 Script Properties（AUTH_SALT），第一次呼叫時自動產生。
 * token：驗證通過後核發，存在 CacheService，標註 case_id 與角色（view/admin），
 *        效期 6 小時（CacheService 上限）。
 */

var TOKEN_TTL_SECONDS = 6 * 60 * 60; // CacheService 最長 6 小時

function getSalt_() {
  var props = PropertiesService.getScriptProperties();
  var salt = props.getProperty('AUTH_SALT');
  if (!salt) {
    salt = Utilities.getUuid();
    props.setProperty('AUTH_SALT', salt);
  }
  return salt;
}

function hashCode_(code, salt) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(code) + salt);
  return digest.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? '0' + v : v;
  }).join('');
}

/**
 * operatorName：管理模式進入時填寫的操作者姓名，之後寫 EventLog 的 actor 用這個，
 * 不用每次寫入都重新傳姓名。檢視模式（role='view'）不需要，傳空字串即可。
 */
function issueToken_(caseId, role, operatorName) {
  var token = Utilities.getUuid();
  var cache = CacheService.getScriptCache();
  cache.put('tok_' + token, JSON.stringify({
    caseId: caseId,
    role: role,
    operatorName: operatorName || ''
  }), TOKEN_TTL_SECONDS);
  return token;
}

function validateToken_(token) {
  if (!token) return null;
  var cache = CacheService.getScriptCache();
  var raw = cache.get('tok_' + token);
  if (!raw) return null;
  return JSON.parse(raw);
}

/**
 * 供之後階段的寫入 action 呼叫：檢查 token 是否具備所需權限，不足就丟出錯誤
 * （doPost 會接住並包成 {ok:false, error:...} 回傳給前端）。
 * requiredRole 'view'：view 或 admin 都通過。
 * requiredRole 'admin'：只有 admin 通過。
 */
function requireAuth_(token, requiredRole, caseId) {
  var info = validateToken_(token);
  if (!info) {
    throw new Error('token 無效或已過期，請重新輸入驗證碼');
  }
  if (caseId && info.caseId !== caseId) {
    throw new Error('token 與案件不符');
  }
  if (requiredRole === 'admin' && info.role !== 'admin') {
    throw new Error('權限不足，此操作需要管理碼');
  }
  // 結案後唯讀：所有需要 admin 權限的寫入動作，案件一旦結案一律擋下（closeCase 自己會先檢查過，
  // 這裡再擋一次是防止繞過前端直接呼叫其他寫入 action）。
  if (requiredRole === 'admin' && caseId) {
    var caseRow = findCaseById_(caseId);
    if (caseRow && caseRow.status === '結案') {
      throw new Error('案件已結案，目前是唯讀狀態，無法再操作');
    }
  }
  return info;
}
