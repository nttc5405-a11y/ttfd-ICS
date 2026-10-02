/**
 * 報表看板的統計數字（甘特圖前端直接重用 getIcsBoard 的場地/任務資料，這裡只算統計表）。
 *
 * 指標定義（見 SPEC 統計定義）：
 * - 人數：不重複 person_id 數
 * - 人次：TaskMembers 筆數
 * - 人時：每筆出勤 (離開時間－加入時間) 加總，未結束的用「現在」算
 * - 報到人數：Personnel 裡報到過的人數（含未出勤者）
 * 注意：同一個人如果離場後又重新報到（例如隔天再來），每次報到都是 Personnel 的新一列
 * （新 person_id，刻意設計成這樣，見 Personnel.gs 的 handleCheckinPersonnel_ 註解），
 * 所以「人數」「報到人數」在全案模式下會把這種情況算成兩筆、不會自動合併成一人；
 * 這是已知、刻意接受的限制（前端報表頁面上也有加註說明），不是計算錯誤。
 * 分日檢視：某人當天有任一出勤時段落在該日即計入當天人數；人時在午夜切段分別計算。
 * 「工作場地」分組的報到人數不計算（打 － ）：報到位置 checkin_zone 是自由文字，
 * 跟 Sites 的實際場地記錄對不起來，硬湊會誤導。
 */

/**
 * action: getReport
 * body: { action:'getReport', token, case_id, mode:'all'|'day', date:'YYYY-MM-DD'（mode=day 時必填）, group_by:'unit'|'sub_unit'|'site' }
 */
function handleGetReport_(body) {
  var caseId = body.case_id;
  requireAuth_(body.token, 'view', caseId);

  var mode = body.mode === 'day' ? 'day' : 'all';
  var groupBy = ['unit', 'sub_unit', 'site'].indexOf(body.group_by) !== -1 ? body.group_by : 'unit';

  var dayStart = null;
  var dayEnd = null;
  if (mode === 'day') {
    var dateStr = String(body.date || '');
    if (!dateStr) return { ok: false, error: '請選擇日期' };
    dayStart = new Date(dateStr + 'T00:00:00+08:00');
    if (isNaN(dayStart.getTime())) return { ok: false, error: '日期格式不正確' };
    dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  }

  var personnel = sheetToObjects_(getSheet_('Personnel')).filter(function (p) { return p.case_id === caseId; });
  var personnelById = {};
  personnel.forEach(function (p) { personnelById[p.person_id] = p; });

  var tasks = sheetToObjects_(getSheet_('Tasks')).filter(function (t) { return t.case_id === caseId; });
  var tasksById = {};
  tasks.forEach(function (t) { tasksById[t.task_id] = t; });

  var sites = sheetToObjects_(getSheet_('Sites')).filter(function (s) { return s.case_id === caseId; });
  var siteNameById = {};
  sites.forEach(function (s) { siteNameById[s.site_id] = s.name; });

  var taskMembers = sheetToObjects_(getSheet_('TaskMembers')).filter(function (tm) {
    return personnelById.hasOwnProperty(tm.person_id);
  });

  var now = new Date();
  var groups = {};

  function ensureGroup(key) {
    if (!groups[key]) groups[key] = { personIds: {}, visits: 0, hours: 0, checkinCount: 0 };
    return groups[key];
  }

  function groupKeyFor(tm, task) {
    var p = personnelById[tm.person_id];
    if (groupBy === 'unit') return p.unit || '（未填單位）';
    if (groupBy === 'sub_unit') return p.sub_unit || '（未填子單位）';
    var siteId = task ? task.site_id : '';
    return siteNameById[siteId] || '（未知場地）';
  }

  taskMembers.forEach(function (tm) {
    var task = tasksById[tm.task_id];
    var joined = new Date(tm.joined_at);
    var left = tm.left_at ? new Date(tm.left_at) : now;

    var effStart = joined;
    var effEnd = left;
    if (mode === 'day') {
      effStart = joined > dayStart ? joined : dayStart;
      effEnd = left < dayEnd ? left : dayEnd;
      if (effStart >= effEnd) return; // 這天沒有交集
    }

    var key = groupKeyFor(tm, task);
    var g = ensureGroup(key);
    g.personIds[tm.person_id] = true;
    g.visits += 1;
    g.hours += (effEnd - effStart) / 3600000;
  });

  if (groupBy !== 'site') {
    personnel.forEach(function (p) {
      if (!p.checkin_at) return;
      if (mode === 'day') {
        var checkinAt = new Date(p.checkin_at);
        if (checkinAt < dayStart || checkinAt >= dayEnd) return;
      }
      var key = groupBy === 'unit' ? (p.unit || '（未填單位）') : (p.sub_unit || '（未填子單位）');
      ensureGroup(key).checkinCount += 1;
    });
  }

  var rows = Object.keys(groups).map(function (key) {
    var g = groups[key];
    return {
      group: key,
      person_count: Object.keys(g.personIds).length,
      visit_count: g.visits,
      hours: Math.round(g.hours * 10) / 10,
      checkin_count: groupBy !== 'site' ? g.checkinCount : null
    };
  }).sort(function (a, b) { return a.group < b.group ? -1 : (a.group > b.group ? 1 : 0); });

  return { ok: true, group_by: groupBy, mode: mode, rows: rows };
}

/**
 * action: getDailyDeployment — 每日人力部署表（依工作場地分組、依人員單位分色），
 * 格式參考現場常見的「現場人次表」：橫向依日期分欄，每欄底下列出當天各場地實際派遣的人員。
 * body: { action:'getDailyDeployment', token, case_id, mode:'all'|'day', date:'YYYY-MM-DD' }
 * 「全案」模式會自動抓出整個案件有人員出勤紀錄的所有日期（從最早到最晚，含中間沒出勤的日子
 * 也會列出空欄，維持日期連續，比較好對照）；「單日」模式只回傳那一天。
 */
function handleGetDailyDeployment_(body) {
  var caseId = body.case_id;
  requireAuth_(body.token, 'view', caseId);

  var mode = body.mode === 'day' ? 'day' : 'all';

  var personnel = sheetToObjects_(getSheet_('Personnel')).filter(function (p) { return p.case_id === caseId; });
  var personnelById = {};
  personnel.forEach(function (p) { personnelById[p.person_id] = p; });

  var tasks = sheetToObjects_(getSheet_('Tasks')).filter(function (t) { return t.case_id === caseId; });
  var tasksById = {};
  tasks.forEach(function (t) { tasksById[t.task_id] = t; });

  var sites = sheetToObjects_(getSheet_('Sites')).filter(function (s) { return s.case_id === caseId; });
  var siteNameById = {};
  sites.forEach(function (s) { siteNameById[s.site_id] = s.name; });

  var taskMembers = sheetToObjects_(getSheet_('TaskMembers')).filter(function (tm) {
    return personnelById.hasOwnProperty(tm.person_id);
  });

  var now = new Date();
  var dateStrs = [];

  if (mode === 'day') {
    var dateStr = String(body.date || '');
    if (!dateStr) return { ok: false, error: '請選擇日期' };
    dateStrs = [dateStr];
  } else {
    if (taskMembers.length === 0) return { ok: true, days: [] };
    var minTime = null, maxTime = null;
    taskMembers.forEach(function (tm) {
      var joined = new Date(tm.joined_at).getTime();
      var left = tm.left_at ? new Date(tm.left_at).getTime() : now.getTime();
      if (minTime === null || joined < minTime) minTime = joined;
      if (maxTime === null || left > maxTime) maxTime = left;
    });
    var cursor = new Date(dateKeyTaipei_(new Date(minTime)) + 'T00:00:00+08:00');
    var endBound = new Date(dateKeyTaipei_(new Date(maxTime)) + 'T00:00:00+08:00');
    while (cursor.getTime() <= endBound.getTime()) {
      dateStrs.push(dateKeyTaipei_(cursor));
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  var days = dateStrs.map(function (dateStr) {
    var dayStart = new Date(dateStr + 'T00:00:00+08:00');
    var dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);

    var siteMap = {}; // site_id -> { site_name, personIds:{}, people:[] }

    taskMembers.forEach(function (tm) {
      var joined = new Date(tm.joined_at);
      var left = tm.left_at ? new Date(tm.left_at) : now;
      if (joined >= dayEnd || left <= dayStart) return; // 這天沒有交集

      var task = tasksById[tm.task_id];
      var siteId = task ? task.site_id : '';
      var siteName = siteNameById[siteId] || '（未知場地）';
      var p = personnelById[tm.person_id];

      if (!siteMap[siteId]) siteMap[siteId] = { site_name: siteName, personIds: {}, people: [] };
      if (siteMap[siteId].personIds[tm.person_id]) return; // 同一天同一場地不重複列
      siteMap[siteId].personIds[tm.person_id] = true;
      siteMap[siteId].people.push({
        name: p ? p.name : '（未知人員）',
        unit: p ? (p.unit || '') : ''
      });
    });

    var siteList = Object.keys(siteMap).map(function (siteId) {
      var s = siteMap[siteId];
      s.people.sort(function (a, b) {
        if (a.unit !== b.unit) return a.unit < b.unit ? -1 : 1;
        return a.name < b.name ? -1 : 1;
      });
      return { site_name: s.site_name, people: s.people };
    });
    siteList.sort(function (a, b) { return a.site_name < b.site_name ? -1 : 1; });

    return { date: dateStr, sites: siteList };
  });

  return { ok: true, days: days };
}

/**
 * 把 Date 物件轉成 Asia/Taipei 的 YYYY-MM-DD 字串，用來判斷「這個時間點算哪一天」跟列舉日期區間。
 * 不能用 Date 物件自己的 getFullYear/getMonth/getDate，那些是依「伺服器執行環境」的時區，
 * GAS 專案雖然設定是 Asia/Taipei，但用 Utilities.formatDate 明確指定時區比較保險、不會因執行環境改變而跑掉。
 */
function dateKeyTaipei_(date) {
  return Utilities.formatDate(date, 'Asia/Taipei', 'yyyy-MM-dd');
}
