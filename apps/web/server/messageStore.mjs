// 简兮 · 站内信投递存储（JSON 落盘）
// 后台发送的站内信经 deliverMessage 写入这里；前端经 /api/message 读取。
// 结构：
//   globals   : 全站广播（所有用户可见）
//   personals : { userId: [ {id,title,content,createdAt} ] } 指定用户私信
// 已读状态由前端 localStorage 按消息 id 追踪（与历史行为一致，跨设备登录会重置）。

import { dataFile, readJson, writeJsonAtomic } from './dataStore.mjs';

const FILE = dataFile('user-messages.json');

let seq = 0;
let globals = [];
let personals = {};
let feedbacks = [];

function load() {
  const raw = readJson(FILE, null);
  if (raw) {
    globals = Array.isArray(raw.globals) ? raw.globals : [];
    personals = raw.personals && typeof raw.personals === 'object' ? raw.personals : {};
    feedbacks = Array.isArray(raw.feedbacks) ? raw.feedbacks : [];
    seq = Number(raw.seq) || 0;
  } else {
    // 首次冷启动（文件尚不存在时）注入初始欢迎信
    seq = 1;
    globals = [
      {
        id: 'm-1',
        title: '欢迎来到简兮·JANSEE 全栈工场',
        content: '零基础不用学剪辑，极简三步出片。支持图片成片、视频配音、出镜口播与实拍分镜四大商业版块，欢迎体验！',
        createdAt: Date.now(),
      },
    ];
    save();
  }
}
function save() {
  writeJsonAtomic(FILE, { seq, globals, personals, feedbacks });
}
load();

/**
 * 投递站内信。
 * @param {{scope:'all'|'user', userId?:string, title:string, content:string}} p
 * @returns 投递的消息对象
 */
export function deliverMessage({ scope, userId, title, content }) {
  seq += 1;
  const msg = { id: `m-${seq}`, title: String(title || ''), content: String(content || ''), createdAt: Date.now() };
  if (scope === 'user' || scope === 'single') {
    const key = String(userId || '');
    personals[key] = personals[key] || [];
    personals[key].push(msg);
  } else {
    globals.push(msg);
  }
  save();
  return msg;
}

/** 某用户可见的全部站内信（全站广播 + 个人私信）按时间倒序 */
export function messagesFor(userId) {
  const list = globals.map((g) => ({ ...g, scope: 'all' }));
  const uid = String(userId || '').trim();
  if (uid && uid !== 'guest' && uid !== 'null' && uid !== 'undefined') {
    const personal = personals[uid] || [];
    personal.forEach((p) => {
      list.push({ ...p, scope: 'user' });
    });
  }
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return list;
}

/** 按 id 删除一条站内信（全站广播或任意用户私信），返回是否命中 */
export function deleteMessage(msgId) {
  const id = String(msgId || '');
  if (!id) return false;
  let found = false;
  const gi = globals.findIndex((m) => m.id === id);
  if (gi >= 0) {
    globals.splice(gi, 1);
    found = true;
  }
  for (const key of Object.keys(personals)) {
    const arr = personals[key];
    const idx = arr.findIndex((m) => m.id === id);
    if (idx >= 0) {
      arr.splice(idx, 1);
      found = true;
      if (!arr.length) delete personals[key];
    }
  }
  if (found) save();
  return found;
}

/** 提交商户意见与问题反馈 (前台只发不收) */
export function addFeedback({ userId, phone, content, contact, type }) {
  seq += 1;
  const fb = {
    id: `fb-${seq}`,
    userId: String(userId || ''),
    phone: String(phone || ''),
    content: String(content || ''),
    contact: String(contact || ''),
    type: String(type || '意见建议'),
    createdAt: Date.now()
  };
  feedbacks.unshift(fb);
  if (feedbacks.length > 200) feedbacks.pop();
  save();
  return fb;
}

/** 获取全部商户反馈列表 (供后台老板查阅) */
export function listFeedbacks() {
  return feedbacks.slice();
}

/** 删除一条商户反馈 */
export function deleteFeedback(fbId) {
  const id = String(fbId || '');
  const idx = feedbacks.findIndex(f => f.id === id);
  if (idx >= 0) {
    feedbacks.splice(idx, 1);
    save();
    return true;
  }
  return false;
}
