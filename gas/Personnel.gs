/**
 * 人員管制：單筆報到、批次報到（貼上多行，也是「預先匯入名冊」用的同一套機制）、
 * 讀取案件的人員清單。
 */

/**
 * action: getPersonnel
 * body: { action:'getPersonnel', token, case_id }
 * 每個人員多附一個算出來的 status（人員狀態不另存，見 SPEC 狀態設計）：
 * 填了 left_at 是「離場」；否則若在 TaskMembers 裡有未結束的紀錄是「任務中」；否則「待命」。
 */
function handleGetPersonnel_(body) {
  var caseId = body.case_id;
  var auth = requireAuth_(body.token, 'view', caseId);
  var mask = shouldMaskNames_(caseId, auth.role);
  var statusMap = personnelStatusMap_(caseId);
  var list = sheetToObjects_(getSheet_('Personnel'))
    .filter(function (p) { return p.case_id === caseId; })
    .map(function (p) {
      var copy = {};
      for (var k in p) copy[k] = p[k];
      copy.status = statusMap[p.person_id] || '待命';
      if (mask) copy.name = maskName_(copy.name);
      return copy;
    });
  return { ok: true, personnel: list };
}

/**
 * person_id → 姓名 對照表，給 Sites.gs/Tasks.gs 顯示帶隊官與派遣人員姓名用。
 */
function personnelNameMap_(caseId) {
  var map = {};
  sheetToObjects_(getSheet_('Personnel')).forEach(function (p) {
    if (p.case_id === caseId) map[p.person_id] = p.name;
  });
  return map;
}

/**
 * person_id → 狀態（任務中/待命/離場）對照表。
 */
function personnelStatusMap_(caseId) {
  var personnel = sheetToObjects_(getSheet_('Personnel')).filter(function (p) {
    return p.case_id === caseId;
  });
  var openTaskPersonIds = {};
  sheetToObjects_(getSheet_('TaskMembers')).forEach(function (tm) {
    if (!tm.left_at) openTaskPersonIds[tm.person_id] = true;
  });

  var map = {};
  personnel.forEach(function (p) {
    if (p.left_at) {
      map[p.person_id] = '離場';
    } else if (openTaskPersonIds[p.person_id]) {
      map[p.person_id] = '任務中';
    } else {
      map[p.person_id] = '待命';
    }
  });
  return map;
}

/**
 * action: checkinPersonnel（單筆報到）
 * body: { action:'checkinPersonnel', token, case_id, unit, sub_unit, name, specialty, checkin_zone }
 */
function handleCheckinPersonnel_(body) {
  var caseId = body.case_id;
  var auth = requireAuth_(body.token, 'admin', caseId);

  var name = String(body.name || '').trim();
  if (!name) return { ok: false, error: '請輸入姓名' };

  var entry = {
    unit: String(body.unit || '').trim(),
    sub_unit: String(body.sub_unit || '').trim(),
    name: name,
    specialty: String(body.specialty || '').trim(),
    checkin_zone: String(body.checkin_zone || '').trim() || '指揮站'
  };

  return withLock_(function () {
    var personId = newId_();
    appendRow_(getSheet_('Personnel'), SHEET_SCHEMAS.Personnel, {
      person_id: personId,
      case_id: caseId,
      unit: entry.unit,
      sub_unit: entry.sub_unit,
      name: entry.name,
      specialty: entry.specialty,
      checkin_zone: entry.checkin_zone,
      checkin_at: nowIso_(),
      left_at: ''
    });
    appendEventLog_(caseId, 'checkin', personId, entry.name, auth.operatorName);
    return { ok: true, person_id: personId };
  });
}

/**
 * action: checkinPersonnelBatch（批次報到／預先匯入名冊，同一套機制：貼上多行文字）
 * body: { action:'checkinPersonnelBatch', token, case_id, text }
 * 每行一人，欄位順序：單位、子單位、姓名、專長、報到位置。分隔符號依序偵測：
 * 有 Tab 用 Tab 分（從 Excel/試算表複製貼上會是這種）；沒有 Tab 但有逗號就用逗號分；
 * 都沒有就把整行當姓名（一行只打一個名字也可以）。姓名是必填，缺姓名的行會被跳過並列出原因，
 * 不會讓整批失敗。
 */
function splitBatchLine_(line) {
  if (line.indexOf('\t') !== -1) return line.split('\t').map(function (c) { return c.trim(); });
  if (line.indexOf(',') !== -1) return line.split(',').map(function (c) { return c.trim(); });
  return ['', '', line.trim(), '', ''];
}
function handleCheckinPersonnelBatch_(body) {
  var caseId = body.case_id;
  var auth = requireAuth_(body.token, 'admin', caseId);

  var text = String(body.text || '');
  var lines = text.split('\n')
    .map(function (l) { return l.replace(/\r$/, ''); })
    .filter(function (l) { return l.trim() !== ''; });

  if (lines.length === 0) return { ok: false, error: '貼上的內容是空的' };

  return withLock_(function () {
    var sheet = getSheet_('Personnel');
    var created = [];
    var skipped = [];

    lines.forEach(function (line, idx) {
      var cols = splitBatchLine_(line);
      var name = cols[2] || '';
      if (!name) {
        skipped.push({ line: idx + 1, text: line, reason: '缺少姓名（第 3 欄）' });
        return;
      }
      var personId = newId_();
      appendRow_(sheet, SHEET_SCHEMAS.Personnel, {
        person_id: personId,
        case_id: caseId,
        unit: cols[0] || '',
        sub_unit: cols[1] || '',
        name: name,
        specialty: cols[3] || '',
        checkin_zone: cols[4] || '指揮站',
        checkin_at: nowIso_(),
        left_at: ''
      });
      created.push({ person_id: personId, name: name });
    });

    if (created.length > 0) {
      var names = created.map(function (c) { return c.name; }).join('、');
      appendEventLog_(caseId, 'checkin_batch', '', created.length + ' 人：' + names, auth.operatorName);
    }

    return { ok: true, created_count: created.length, skipped: skipped };
  });
}
