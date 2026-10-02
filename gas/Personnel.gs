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
 *
 * 允許「重新報到」：同一個人離場後（例如隔天又來），再報到一次會建立**新的一筆**報到紀錄
 * （新的 person_id），不會去找回原本那筆、也不會擋下來——這是刻意的設計，原因：
 *   1. 工作記事要完整留存「每一次」報到/簽退的歷史，不能因為重新報到就覆蓋掉舊紀錄。
 *   2. 跟 TaskMembers（一個人可以在同一個任務有好幾段加入/離開紀錄）的設計邏輯一致。
 * 代價：報表看板「全案」模式的人數/報到人數統計，會把同一人的兩次報到當成兩筆分開計算
 * （不會自動合併成一人），這是已知、刻意接受的限制，不是 bug；報表頁面上有加註說明。
 * 為了避免看起來像誤植重複，回傳時如果偵測到「同單位、同姓名」之前有簽退過的紀錄，
 * 會附上 rejoin_note，前端會顯示一句提醒文字（純提示，不會擋下報到）。
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

  var priorCheckedOut = sheetToObjects_(getSheet_('Personnel')).some(function (p) {
    return p.case_id === caseId && p.unit === entry.unit && p.name === entry.name && p.left_at;
  });

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
    var result = { ok: true, person_id: personId };
    if (priorCheckedOut) {
      result.rejoin_note = '「' + entry.name + '」在' + (entry.unit ? '「' + entry.unit + '」' : '這個案件') +
        '之前已經有簽退過的報到紀錄，這次會視為重新報到（新增一筆，不會覆蓋舊紀錄）。';
    }
    return result;
  });
}

/**
 * action: checkinPersonnelBatch（批次報到／預先匯入名冊，同一套機制：貼上多行文字）
 * body: { action:'checkinPersonnelBatch', token, case_id, text }
 *
 * 分隔符號依序偵測：有 Tab 用 Tab 分（從 Excel/試算表複製貼上會是這種）；
 * 沒有 Tab 但有逗號就用逗號分；都沒有就把整行當姓名。
 * 欄位數決定意思（這是刻意設計成「欄位數＝格式」，不猜單位名稱在哪裡結束，
 * 避免位置配對猜錯導致資料靜默錯置）：
 *   3 欄以上：單位、子單位、姓名、[專長]、[報到位置]（原本的完整格式，不變）
 *   剛好 2 欄：單位、姓名（同一單位多人用這個，子單位留空）
 *   只有 1 欄（沒有 Tab/逗號）：整行當姓名，不含單位
 * 「姓名」那一欄可以用「.」分隔同一單位/子單位的多個人，例如：
 *   成功分隊,A.B.C.D.E          → 5 人，都是「成功分隊」
 *   都蘭分隊,A小隊,F.G.H.J      → 4 人，都是「都蘭分隊／A小隊」
 * 姓名是必填，缺姓名的行會被跳過並列出原因，不會讓整批失敗。
 */
function splitBatchLine_(line) {
  if (line.indexOf('\t') !== -1) return line.split('\t').map(function (c) { return c.trim(); });
  if (line.indexOf(',') !== -1) return line.split(',').map(function (c) { return c.trim(); });
  return [line.trim()];
}

/**
 * 依欄位數判斷這一行的意思，並把「姓名」欄用「.」展開成多個姓名。
 * 回傳 { unit, sub_unit, names:[...], specialty, checkin_zone }，names 可能是空陣列（代表這行沒姓名）。
 */
function parseBatchLine_(line) {
  var cols = splitBatchLine_(line);
  var unit = '', subUnit = '', namesField = '', specialty = '', zone = '';

  if (cols.length >= 3) {
    unit = cols[0] || '';
    subUnit = cols[1] || '';
    namesField = cols[2] || '';
    specialty = cols[3] || '';
    zone = cols[4] || '';
  } else if (cols.length === 2) {
    unit = cols[0] || '';
    namesField = cols[1] || '';
  } else {
    namesField = cols[0] || '';
  }

  var names = namesField.split('.')
    .map(function (n) { return n.trim(); })
    .filter(function (n) { return n; });

  return { unit: unit, sub_unit: subUnit, names: names, specialty: specialty, checkin_zone: zone || '指揮站' };
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
      var parsed = parseBatchLine_(line);
      if (parsed.names.length === 0) {
        skipped.push({ line: idx + 1, text: line, reason: '缺少姓名' });
        return;
      }
      parsed.names.forEach(function (name) {
        var personId = newId_();
        appendRow_(sheet, SHEET_SCHEMAS.Personnel, {
          person_id: personId,
          case_id: caseId,
          unit: parsed.unit,
          sub_unit: parsed.sub_unit,
          name: name,
          specialty: parsed.specialty,
          checkin_zone: parsed.checkin_zone,
          checkin_at: nowIso_(),
          left_at: ''
        });
        created.push({ person_id: personId, name: name });
      });
    });

    if (created.length > 0) {
      var names = created.map(function (c) { return c.name; }).join('、');
      appendEventLog_(caseId, 'checkin_batch', '', created.length + ' 人：' + names, auth.operatorName);
    }

    return { ok: true, created_count: created.length, skipped: skipped };
  });
}

/**
 * 從 personIds 裡找出「已經簽退（left_at 有值）」的人，回傳 [{person_id, name}]。
 * 派遣任務／任務中增加人員前用這個擋下「指派已經離場的人」這種不合理狀態
 * （Tasks.gs 的 createTask／updateTaskMembers 會呼叫）。
 */
function findCheckedOutAmong_(caseId, personIds) {
  if (!personIds || personIds.length === 0) return [];
  var nameMap = personnelNameMap_(caseId);
  var leftSet = {};
  sheetToObjects_(getSheet_('Personnel')).forEach(function (p) {
    if (p.case_id === caseId && p.left_at) leftSet[p.person_id] = true;
  });
  return personIds.filter(function (id) { return leftSet[id]; })
    .map(function (id) { return { person_id: id, name: nameMap[id] || '（未知人員）' }; });
}

/**
 * action: checkoutPersonnel（簽退，支援單筆或一次多筆，前端都丟陣列）
 * body: { action:'checkoutPersonnel', token, case_id, person_ids:[...] }
 * 已經簽退過、或目前還在「任務中」（被派遣在某個 ICS 任務上）的人會被跳過並列出原因，
 * 不會讓整批失敗；「任務中」的人要先從任務的「增減人員」移除，才能簽退——這是刻意的，
 * 避免人還掛在執行中的任務上，畫面卻顯示已經離場，造成指揮官誤判現場人力。
 */
function handleCheckoutPersonnel_(body) {
  var caseId = body.case_id;
  var auth = requireAuth_(body.token, 'admin', caseId);

  var personIds = Array.isArray(body.person_ids)
    ? body.person_ids.filter(function (id, idx, arr) { return id && arr.indexOf(id) === idx; })
    : [];
  if (personIds.length === 0) return { ok: false, error: '請選擇要簽退的人員' };

  var statusMap = personnelStatusMap_(caseId);
  var nameMap = personnelNameMap_(caseId);

  return withLock_(function () {
    var checkedOut = [];
    var skipped = [];

    personIds.forEach(function (pid) {
      var name = nameMap[pid] || '（未知人員）';
      var status = statusMap[pid];
      if (!nameMap.hasOwnProperty(pid)) {
        skipped.push({ person_id: pid, name: name, reason: '不屬於這個案件' });
        return;
      }
      if (status === '離場') {
        skipped.push({ person_id: pid, name: name, reason: '已經簽退過' });
        return;
      }
      if (status === '任務中') {
        skipped.push({ person_id: pid, name: name, reason: '仍在任務中，需先從任務「增減人員」移除才能簽退' });
        return;
      }
      updateRow_('Personnel', function (r) {
        return r.case_id === caseId && r.person_id === pid;
      }, { left_at: nowIso_() });
      checkedOut.push({ person_id: pid, name: name });
    });

    if (checkedOut.length > 0) {
      var names = checkedOut.map(function (c) { return c.name; }).join('、');
      appendEventLog_(caseId, 'checkout', '', checkedOut.length + ' 人：' + names, auth.operatorName);
    }

    return { ok: true, checked_out_count: checkedOut.length, skipped: skipped };
  });
}
