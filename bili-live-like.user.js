// ==UserScript==
// @name         B站直播间点赞助手
// @namespace    workbuddy.local/bili-like
// @version      2.2.3
// @description  在 B 站直播间原生点赞按钮上集成批量点赞，右键打开紧凑设置面板；自动开关与次数按直播间分别记忆，统计当日全站点赞总数与逐房间明细；每日每房间 300 赞上限
// @author       WorkBuddy
// @license      MIT
// @match        https://live.bilibili.com/*
// @icon         https://live.bilibili.com/favicon.ico
// @grant        none
// @noframes
// @run-at       document-idle
// ==/UserScript==

// 发布到 Greasy Fork 的注意事项（不影响运行，可整段删除）：
// 1. @namespace 必须保持 workbuddy.local/bili-like 不变，Tampermonkey 才认作同一个脚本、
//    能原地升级；改成 greasyfork.org/users/xxx 会被当成新脚本，与本地版并存两份。
// 2. @description 只放一句话（列表页会截断），详细说明请填在 Greasy Fork 表单的「附加信息」里。
// 3. 在 Greasy Fork 页面编辑代码后，必须把 @version 往上加（2.2.2 → 2.2.3）才会推送更新。
// 4. @downloadURL / @updateURL 由 Greasy Fork 自动注入，不用手写。

(function () {
  'use strict';

  const API = 'https://api.live.bilibili.com/xlive/app-ucenter/v1/like_info_v3/like/likeReportV3';
  const HOST_ID = 'wb-bili-like-host';
  const PANEL_ID = 'wb-bili-like-panel';
  const STYLE_ID = 'wb-bili-like-style';
  // @grant none 时脚本直接跑在页面上下文，可直接读到 BilibiliLive
  const page = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  // === 行为配置：想换交互只改这一行，重新加载脚本即可 ===
  // 'batch' = 左键点原生点赞按钮：原生 +1 照旧，同时自动跑完一批（推荐）
  // 'panel' = 左键点原生点赞按钮：只弹出设置面板，由面板里的「开始」触发点赞
  const CLICK_ACTION = 'batch';
  // 原生点赞按钮：B 站 Web 端聊天输入栏上方工具栏里的「大拇指」。
  // 实测 DOM：<div class="like-btn not-clicked" data-event-name="dianzan.0.show" ...>
  // 写成多候选 + 事件委托，SPA 切房 / Vue 重渲染后无需重新绑定。
  const NATIVE_LIKE_SELECTOR = '.like-btn, [data-event-name="dianzan.0.show"], [data-type^="dianzan."]';
  // 配置：defaults 是新房间的默认值，byRoom[roomId] 是各直播间自己的设置
  const CFG_KEY = 'wb-bili-like-config';
  const DEFAULT_CFG = { times: '10', per: '30', delay: '1000' };
  // 自动开关按房间单独存；每日点赞记录独立成键，便于统计当日全站总数
  const AUTO_KEY = 'wb-bili-like-auto';
  const RECORD_KEY = 'wb-bili-like-records';
  // 房间号 → 主播昵称，长期缓存（跨天不失效），统计里给房间号配上主播名字
  const NAMES_KEY = 'wb-bili-like-names';
  const DAILY_LIMIT = 300;

  // 面板藏在封闭 Shadow DOM 里：文字不会出现在 document 的 innerText / textContent / innerHTML，
  // 外部脚本也无法通过 host.shadowRoot 进入；样式同样不会与页面互相污染。
  if (document.getElementById(HOST_ID)) return;

  // 升级清理：v1.9.1 及更早版本把面板和 <style> 直接挂在 document 上。
  // 若 Tampermonkey 里还留着旧脚本实例，或 SPA 刷新后残留 DOM，这些节点会继续被页面读成正文；
  // 复用切房轮询持续清理，避免旧脚本反复重建。
  function cleanupStaleDom() {
    ['wb-bili-like-panel', 'wb-bili-like-style'].forEach((id) => {
      const stale = document.getElementById(id);
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
    });
  }
  cleanupStaleDom();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (value, min, max, fallback) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };

  function getCookie(name) {
    const prefix = name + '=';
    for (const part of document.cookie.split(';')) {
      const item = part.trim();
      if (item.startsWith(prefix)) return decodeURIComponent(item.slice(prefix.length));
    }
    return null;
  }

  // 统一带超时，避免请求挂起把 running 锁永久卡住
  async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs || 10000);
    try {
      return await fetch(url, Object.assign({}, options, { signal: controller.signal }));
    } finally {
      clearTimeout(timer);
    }
  }

  // URL 里的房间号是 SPA 切房时唯一可靠的「当前房间」标识
  function roomIdFromUrl() {
    const matched = location.pathname.match(/\/(\d+)/);
    return matched ? matched[1] : null;
  }

  // 官方只读接口：权威长号 + 主播 UID + 开播状态，不受页面全局对象缓存影响
  async function fetchRoomInfo(urlRoom) {
    try {
      const response = await fetchWithTimeout(
        'https://api.live.bilibili.com/room/v1/Room/get_info?room_id=' + encodeURIComponent(urlRoom),
        { credentials: 'include' },
        8000
      );
      const json = await response.json();
      if (json.code === 0 && json.data && json.data.room_id) {
        return {
          roomId: String(json.data.room_id),
          anchorId: json.data.uid ? String(json.data.uid) : '',
          shortId: json.data.short_id ? String(json.data.short_id) : '',
          // 1=直播中，0=未开播，2=轮播中；B 站规则下只有 1 点赞才有效
          liveStatus: json.data.live_status != null ? Number(json.data.live_status) : null
        };
      }
    } catch (error) {
      console.warn('[点赞助手] 房间信息查询失败', error);
    }
    return null;
  }

  // 页面初始化对象里也带开播状态，作为只读接口不可用时的兜底
  function liveStatusFromPage() {
    try {
      const neptune = page.__NEPTUNE_IS_MY_WAIFU__ || {};
      const init = (neptune.roomInitRes && neptune.roomInitRes.data)
        || (page.__SSR_INITIAL_STATE__ && page.__SSR_INITIAL_STATE__.roomInfo) || {};
      return init.live_status != null ? Number(init.live_status) : null;
    } catch (error) {
      return null;
    }
  }

  function describeLiveStatus(status) {
    if (status == null) return '未知';
    if (status === 1) return '直播中(1)';
    if (status === 0) return '未开播(0)';
    if (status === 2) return '轮播中(2)';
    return '状态(' + status + ')';
  }

  // 页面全局对象只用于显示与兜底，且必须校验它属于当前 URL 的房间
  function readRoomInfo() {
    const urlRoom = roomIdFromUrl();
    const live = page.BilibiliLive;
    if (live && live.ROOMID && String(live.ROOMID) === urlRoom) {
      return { roomId: String(live.ROOMID), anchorId: live.ANCHOR_UID ? String(live.ANCHOR_UID) : '' };
    }

    const state = page.__SSR_INITIAL_STATE__;
    if (state && state.baseInfoRoom) {
      const roomInfo = state.baseInfoRoom.room_info || {};
      const anchorInfo = (state.baseInfoRoom.anchor_info || {}).base_info || {};
      if (roomInfo.room_id && String(roomInfo.room_id) === urlRoom) {
        return {
          roomId: String(roomInfo.room_id),
          anchorId: String(anchorInfo.uid || roomInfo.uid || '')
        };
      }
    }

    if (urlRoom) return { roomId: urlRoom, anchorId: '' };
    return null;
  }

  async function fillAnchor(info) {
    if (info.anchorId) return info;
    const api = await fetchRoomInfo(info.roomId);
    if (api && api.anchorId) return { roomId: api.roomId, anchorId: api.anchorId };
    return info;
  }

  // 每次任务都重新解析：以 URL + get_info 为准，不信任 SPA 残留的 BilibiliLive
  async function resolveRoom() {
    const urlRoom = roomIdFromUrl();
    if (!urlRoom) return null;

    const api = await fetchRoomInfo(urlRoom);
    const live = page.BilibiliLive;
    const liveRoom = live && live.ROOMID ? String(live.ROOMID) : '';

    if (api) {
      // 全局对象确实指向当前房间时，沿用原脚本已验证可用的 ANCHOR_UID
      const liveMatches = liveRoom === api.roomId && !!live.ANCHOR_UID;
      return {
        roomId: api.roomId,
        recordKey: urlRoom,
        anchorId: liveMatches ? String(live.ANCHOR_UID) : api.anchorId,
        liveStatus: api.liveStatus
      };
    }

    const fallback = readRoomInfo();
    if (!fallback) return null;
    const filled = await fillAnchor(fallback);
    if (!filled.anchorId) return null;
    return {
      roomId: filled.roomId,
      recordKey: urlRoom,
      anchorId: filled.anchorId,
      liveStatus: liveStatusFromPage()
    };
  }

  // ---------------------------------------------------------------------------
  // WBI 签名：B 站自 2023-03 起对 Web 端接口启用的通用鉴权（w_rid / wts）。
  // 直播间点赞接口现已要求签名，且参数由「POST 表单体」改为「URL query + 空 body」。
  // 这里只补齐官方必需的字段，让请求格式与页面原生点赞按钮一致。
  // ---------------------------------------------------------------------------
  const NAV_API = 'https://api.bilibili.com/x/web-interface/nav';
  const WEB_LOCATION = '444.8';
  const WBI_CACHE_KEY = 'wb-bili-like-wbi';
  const MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
  ];
  // 仅作 nav 接口不可用时的兜底，官方密钥每天轮换，正常路径都会动态获取
  const FALLBACK_IMG_KEY = '7cd084941338484aae1ad9425b84077c';
  const FALLBACK_SUB_KEY = '4932caff0ff746eab6f01bf08b70ac45';

  // 纯 JS MD5：Web Crypto 的 SubtleCrypto 不支持 MD5，只能自己算
  function md5(input) {
    const bytes = [];
    for (let i = 0; i < input.length; i++) {
      const code = input.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
      } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
        const next = input.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          const cp = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
          bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
            0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
          i++;
        } else {
          bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        }
      } else {
        bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    }

    const bitLength = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    bytes.push(bitLength & 0xff, (bitLength >>> 8) & 0xff,
      (bitLength >>> 16) & 0xff, (bitLength >>> 24) & 0xff, 0, 0, 0, 0);

    const K = [];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    const S = [
      7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
      5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
      4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
      6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
    ];
    const rotl = (x, s) => (x << s) | (x >>> (32 - s));
    let a0 = 0x67452301;
    let b0 = 0xefcdab89;
    let c0 = 0x98badcfe;
    let d0 = 0x10325476;

    for (let offset = 0; offset < bytes.length; offset += 64) {
      const M = [];
      for (let j = 0; j < 16; j++) {
        const k = offset + j * 4;
        M[j] = (bytes[k] | (bytes[k + 1] << 8) | (bytes[k + 2] << 16) | (bytes[k + 3] << 24)) >>> 0;
      }
      let A = a0;
      let B = b0;
      let C = c0;
      let D = d0;
      for (let i = 0; i < 64; i++) {
        let F;
        let g;
        if (i < 16) { F = (B & C) | (~B & D); g = i; }
        else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
        else { F = C ^ (B | ~D); g = (7 * i) % 16; }
        F = (F + A + K[i] + M[g]) >>> 0;
        A = D;
        D = C;
        C = B;
        B = (B + rotl(F, S[i])) >>> 0;
      }
      a0 = (a0 + A) >>> 0;
      b0 = (b0 + B) >>> 0;
      c0 = (c0 + C) >>> 0;
      d0 = (d0 + D) >>> 0;
    }

    const toHex = (n) => {
      let out = '';
      for (let i = 0; i < 4; i++) out += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
      return out;
    };
    return toHex(a0) + toHex(b0) + toHex(c0) + toHex(d0);
  }

  function keyFromUrl(url) {
    return String(url).substring(String(url).lastIndexOf('/') + 1).split('.')[0];
  }

  function makeMixinKey(imgKey, subKey) {
    const raw = imgKey + subKey;
    if (raw.length < 64) return null;
    let mixed = '';
    for (let i = 0; i < MIXIN_KEY_ENC_TAB.length; i++) mixed += raw.charAt(MIXIN_KEY_ENC_TAB[i]);
    return mixed.slice(0, 32);
  }

  function readWbiCache() {
    try {
      return JSON.parse(localStorage.getItem(WBI_CACHE_KEY) || 'null');
    } catch (error) {
      return null;
    }
  }

  // nav 接口返回当天有效的 img_url / sub_url，按本机日期缓存，跨天自动刷新
  async function getWbiMixinKey() {
    const cached = readWbiCache();
    if (cached && cached.date === todayKey() && cached.mixinKey) return cached.mixinKey;

    try {
      const response = await fetchWithTimeout(NAV_API, { credentials: 'include' }, 8000);
      const json = await response.json();
      const wbiImg = json && json.data && json.data.wbi_img;
      if (wbiImg && wbiImg.img_url && wbiImg.sub_url) {
        const mixinKey = makeMixinKey(keyFromUrl(wbiImg.img_url), keyFromUrl(wbiImg.sub_url));
        if (mixinKey) {
          try {
            localStorage.setItem(WBI_CACHE_KEY, JSON.stringify({ date: todayKey(), mixinKey }));
          } catch (error) {
            console.warn('[点赞助手] WBI 密钥缓存写入失败', error);
          }
          return mixinKey;
        }
      }
    } catch (error) {
      console.warn('[点赞助手] 获取 WBI 密钥失败，尝试使用缓存', error);
    }

    if (cached && cached.mixinKey) return cached.mixinKey;
    return makeMixinKey(FALLBACK_IMG_KEY, FALLBACK_SUB_KEY);
  }

  // 按官方规则生成签名后的 query：参数按 key 排序、过滤 !'()*、编码后拼接，再 MD5(query + mixinKey)
  function buildWbiQuery(params, mixinKey, wts) {
    const signed = Object.assign({}, params, { wts: wts });
    const query = Object.keys(signed).sort().map((key) => {
      const value = String(signed[key]).replace(/[!'()*]/g, '');
      return encodeURIComponent(key) + '=' + encodeURIComponent(value);
    }).join('&');
    return query + '&w_rid=' + md5(query + mixinKey) + '&wts=' + wts;
  }

  // 现行接口形态：参数全在 URL query，POST body 为空，必须带 WBI 签名
  async function reportLike({ roomId, anchorId, uid, csrf, clickTime }) {
    const mixinKey = await getWbiMixinKey();
    if (!mixinKey) throw new Error('无法获取 WBI 签名密钥（nav 接口不可用且无缓存）');

    const params = {
      click_time: String(clickTime),
      room_id: roomId,
      uid: uid,
      anchor_id: anchorId,
      web_location: WEB_LOCATION,
      csrf: csrf
    };
    const wts = Math.round(Date.now() / 1000);
    const query = buildWbiQuery(params, mixinKey, wts);
    const url = API + '?' + query;

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      mode: 'cors',
      credentials: 'include',
      referrer: 'https://live.bilibili.com/' + roomId,
      headers: {
        'accept': 'application/json, text/plain, */*',
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: ''
    }, 10000);
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const data = await response.json();
    if (data.code !== 0) {
      throw new Error('code=' + data.code + ' ' + (data.message || data.msg || ''));
    }
    // 签名或风控校验未通过时，接口仍可能返回 code=0，只在 data 里塞 v_voucher
    const payload = typeof data.data === 'string' ? data.data : JSON.stringify(data.data || '');
    if (payload.indexOf('v_voucher') !== -1) {
      throw new Error('code=0 但返回 v_voucher：本次未计入');
    }
    return data;
  }

  function injectStyle(root) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
/* Win11 Fluent：Mica / Acrylic 材质、分层柔光阴影、Segoe UI Variable、系统强调色。
   全部颜色收在 :host 自定义属性里，浅色 / 深色两套随系统主题自动切换。 */
:host{
  --wb-accent:#0f6cbd;--wb-accent-hover:#0b5aa6;--wb-accent-press:#094b8b;--wb-accent-fg:#fff;
  --wb-text:#1b1b1f;--wb-text-sub:#61616c;
  --wb-surface:rgba(249,250,252,.92);--wb-surface-2:rgba(255,255,255,.82);--wb-surface-3:rgba(255,255,255,.62);
  --wb-stroke:rgba(0,0,0,.07);--wb-stroke-strong:rgba(0,0,0,.14);--wb-hairline:rgba(255,255,255,.80);
  --wb-hover:rgba(0,0,0,.045);--wb-press:rgba(0,0,0,.075);--wb-track:rgba(0,0,0,.09);
  --wb-ok-fg:#0d6b3d;--wb-ok-bg:rgba(218,244,230,.88);
  --wb-err-fg:#b52a1c;--wb-err-bg:rgba(253,231,228,.90);
  --wb-neutral-bg:rgba(0,0,0,.045);
  --wb-shadow:0 16px 40px rgba(0,0,0,.16),0 4px 12px rgba(0,0,0,.10);
  color-scheme:light
}
@media (prefers-color-scheme:dark){
:host{
  --wb-accent:#60cdff;--wb-accent-hover:#7fd7ff;--wb-accent-press:#2fb2ee;--wb-accent-fg:#00304d;
  --wb-text:#f4f4f6;--wb-text-sub:#bdbdc6;
  --wb-surface:rgba(39,39,43,.93);--wb-surface-2:rgba(255,255,255,.10);--wb-surface-3:rgba(255,255,255,.07);
  --wb-stroke:rgba(255,255,255,.09);--wb-stroke-strong:rgba(255,255,255,.19);--wb-hairline:rgba(255,255,255,.12);
  --wb-hover:rgba(255,255,255,.075);--wb-press:rgba(255,255,255,.115);--wb-track:rgba(255,255,255,.13);
  --wb-ok-fg:#7fe0a8;--wb-ok-bg:rgba(20,83,55,.45);
  --wb-err-fg:#ff9c91;--wb-err-bg:rgba(120,40,34,.42);
  --wb-neutral-bg:rgba(255,255,255,.07);
  --wb-shadow:0 18px 44px rgba(0,0,0,.52),0 4px 14px rgba(0,0,0,.38);
  color-scheme:dark
}
}
/* 面板默认完全隐藏：页面上没有任何常驻的自制 UI。
   只有右键原生点赞按钮才出现，位置由 JS 按按钮矩形计算，不可拖动、不记位置。 */
#${PANEL_ID}{position:fixed;left:0;top:0;z-index:99999;width:180px;background:var(--wb-surface);color:var(--wb-text);border:1px solid var(--wb-hairline);border-radius:10px;box-shadow:var(--wb-shadow),0 0 0 1px var(--wb-stroke);-webkit-backdrop-filter:blur(30px) saturate(1.8);backdrop-filter:blur(30px) saturate(1.8);font:12px/1.4 "Segoe UI Variable Text","Segoe UI Variable","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif;overflow:hidden;visibility:hidden;opacity:0;pointer-events:none}
#${PANEL_ID}.wb-open{visibility:visible;opacity:1;pointer-events:auto}
#${PANEL_ID} *{box-sizing:border-box}
/* 去掉原生 button appearance：否则半透明底色会叠在 UA 的 ButtonFace 上，深浅主题下颜色不一致 */
#${PANEL_ID} button,.wb-toast{-webkit-appearance:none;appearance:none}
.wb-head{display:flex;align-items:center;gap:6px;padding:7px 7px 7px 9px;background:var(--wb-surface-3);border-bottom:1px solid var(--wb-stroke);font-size:11.5px;font-weight:600;letter-spacing:.1px;cursor:default;user-select:none}
.wb-head::before{content:"";flex:none;width:11px;height:11px;border-radius:3px;background:linear-gradient(150deg,var(--wb-accent),rgba(15,108,189,.55));box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 1px 3px rgba(0,0,0,.15)}
.wb-title{color:var(--wb-text)}
.wb-close{margin-left:auto;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--wb-text-sub);font:400 15px/1 "Segoe UI",sans-serif;cursor:pointer;transition:background-color .15s,color .15s}
.wb-close:hover{background:var(--wb-hover);color:var(--wb-text)}
.wb-close::after{content:attr(data-label)}
.wb-body{padding:8px}
.wb-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;gap:6px}
.wb-row label{color:var(--wb-text-sub);font-size:11.5px;white-space:nowrap}
.wb-row input{width:70px;padding:3px 6px;border:1px solid var(--wb-stroke-strong);border-bottom:2px solid var(--wb-text-sub);border-radius:5px;background:var(--wb-surface-2);color:var(--wb-text);font-family:inherit;font-size:11.5px;line-height:1.3;outline:none;transition:background-color .15s,border-color .15s}
.wb-row input:focus{border-bottom-color:var(--wb-accent)}
.wb-row input::-webkit-inner-spin-button{opacity:.45}
.wb-row label.wb-check{display:flex;align-items:center;gap:8px;color:var(--wb-text);font-size:11.5px;cursor:pointer}
.wb-row input[type="checkbox"]{-webkit-appearance:none;appearance:none;position:relative;flex:none;width:30px;height:17px;padding:0;margin:0;border:1px solid var(--wb-stroke-strong);border-bottom-width:1px;border-radius:9px;background:var(--wb-surface-2);cursor:pointer;transition:background-color .18s,border-color .18s}
.wb-row input[type="checkbox"]::before{content:"";position:absolute;left:2px;top:2px;width:11px;height:11px;border-radius:50%;background:var(--wb-text-sub);box-shadow:0 1px 2px rgba(0,0,0,.18);transition:transform .2s cubic-bezier(.2,.8,.2,1),background-color .18s}
.wb-row input[type="checkbox"]:checked{background:var(--wb-accent);border-color:transparent}
.wb-row input[type="checkbox"]:checked::before{transform:translateX(13px);background:#fff}
.wb-row input[type="checkbox"]:focus-visible{outline:2px solid var(--wb-accent);outline-offset:2px}
.wb-today{position:relative;display:flex;align-items:center;justify-content:space-between;margin:0 0 7px;padding:4px 7px 8px;border:1px solid var(--wb-stroke);border-radius:6px;background:var(--wb-neutral-bg);color:var(--wb-text-sub);font-size:11px;overflow:hidden}
.wb-today::before,.wb-today::after{content:"";position:absolute;left:7px;bottom:3px;width:calc(100% - 14px);height:2px;border-radius:2px}
.wb-today::before{background:var(--wb-track)}
.wb-today::after{z-index:1;background:var(--wb-accent);transform:scaleX(var(--wb-progress,0));transform-origin:left center;transition:transform .35s cubic-bezier(.2,.8,.2,1)}
.wb-link{border:0;border-radius:4px;background:transparent;color:var(--wb-accent);cursor:pointer;font-family:inherit;font-size:11px;font-weight:600;padding:1px 3px;transition:background-color .15s}
.wb-link:hover{background:var(--wb-hover)}
.wb-hint{color:var(--wb-text-sub);font-size:10px;font-weight:400}
/* 当日全站累计：各直播间分别计数后汇总；点一下展开逐房间明细（主播名 + 房间号） */
.wb-total{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:0 0 7px;padding:4px 7px;border:1px dashed var(--wb-stroke-strong);border-radius:6px;background:var(--wb-neutral-bg);color:var(--wb-text-sub);font-size:10.5px;line-height:1.3;white-space:nowrap;cursor:pointer;user-select:none;transition:border-color .15s,background-color .15s}
.wb-total:hover{border-color:var(--wb-accent);background:var(--wb-hover)}
.wb-total:focus-visible{outline:2px solid var(--wb-accent);outline-offset:1px}
.wb-total b{color:var(--wb-text);font-weight:600;font-variant-numeric:tabular-nums}
.wb-total .wb-total-num{color:var(--wb-accent)}
.wb-total-caret{font-size:8px;line-height:1;opacity:.6;transition:transform .15s}
.wb-total[aria-expanded="true"] .wb-total-caret{transform:rotate(180deg)}
/* 展开明细时面板临时加宽，给「主播名 + 房间号 + 赞数」留出阅读空间；收起态仍是原尺寸 */
#${PANEL_ID}.wb-wide{width:212px}
/* 逐房间明细：一行一个直播间，主播名在前、房间号紧随其后 */
.wb-total-list{margin:-3px 0 7px;padding:0;display:flex;flex-direction:column;gap:1px}
/* 用 display:flex 覆盖了 UA 的 [hidden]，必须显式声明，否则收起态仍然占位 */
.wb-total-list[hidden]{display:none}
.wb-total-item{display:flex;align-items:center;gap:8px;padding:2px 6px;border-radius:4px;font-size:10.5px;line-height:1.4;color:var(--wb-text-sub)}
.wb-total-item.wb-cur{background:var(--wb-neutral-bg)}
.wb-total-item .wb-ti-main{flex:1;display:flex;align-items:baseline;gap:5px;min-width:0}
.wb-total-item .wb-ti-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--wb-text)}
.wb-total-item .wb-ti-id{flex:none;font-size:9.5px;opacity:.62;font-variant-numeric:tabular-nums}
.wb-total-item .wb-ti-num{flex:none;min-width:38px;text-align:right;font-weight:600;color:var(--wb-accent);font-variant-numeric:tabular-nums}
.wb-total-empty{padding:2px 6px;font-size:10.5px;color:var(--wb-text-sub);opacity:.8}
.wb-btns{display:flex;gap:6px;margin:0 0 8px}
.wb-btns button{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:5px;padding:5px 0;border:1px solid var(--wb-stroke);border-radius:5px;background:var(--wb-surface-2);color:var(--wb-text);font-family:inherit;font-size:11.5px;font-weight:500;line-height:1.2;white-space:nowrap;cursor:pointer;box-shadow:0 1px 1px rgba(0,0,0,.03);transition:background-color .15s,border-color .15s,box-shadow .15s}
.wb-btns button::before{content:"";flex:none}
#wb-start::before{width:0;height:0;border-left:5px solid currentColor;border-top:3px solid transparent;border-bottom:3px solid transparent}
#wb-stop::before{width:6px;height:6px;border-radius:1px;background:currentColor}
#wb-start{background:var(--wb-accent);border-color:transparent;color:var(--wb-accent-fg);font-weight:600;box-shadow:0 2px 6px rgba(15,108,189,.24)}
#wb-start:hover:not(:disabled){background:var(--wb-accent-hover);box-shadow:0 3px 10px rgba(15,108,189,.30)}
#wb-start:active:not(:disabled){background:var(--wb-accent-press);box-shadow:none}
.wb-btns button:hover:not(:disabled){background:var(--wb-hover)}
.wb-btns button:active:not(:disabled){background:var(--wb-press);box-shadow:none}
.wb-btns button:focus-visible{outline:2px solid var(--wb-accent);outline-offset:1px}
.wb-btns button:disabled{opacity:.42;cursor:not-allowed;box-shadow:none}
/* 状态栏是四边留边的独立圆角块：不再顶到面板底边，避免被面板圆角 overflow 剪成直角 */
.wb-status{min-height:32px;display:flex;align-items:center;gap:6px;padding:5px 8px;border:1px solid var(--wb-stroke);border-radius:6px;background:var(--wb-neutral-bg);color:var(--wb-text-sub);font-size:11px;line-height:1.3;word-break:break-all;transition:background-color .2s,color .2s}
.wb-status::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--wb-text-sub);opacity:.75}
.wb-status.wb-ok{background:var(--wb-ok-bg);color:var(--wb-ok-fg)}
.wb-status.wb-ok::before{background:var(--wb-ok-fg);opacity:1}
.wb-status.wb-err{background:var(--wb-err-bg);color:var(--wb-err-fg)}
.wb-status.wb-err::before{background:var(--wb-err-fg);opacity:1}
/*    运行时状态胶囊：直接贴在原生点赞按钮上方，任务期间出现、结束数秒后自动消失。
   不是常驻图标、不可拖动；文字走 data-label + 伪元素，不产生可外泄的文本节点。
   刻意不用 opacity 淡入：首帧半透明会让刚点完按钮的即时反馈看不清，也拖慢连点。 */
.wb-toast{position:fixed;left:0;top:0;z-index:100000;display:flex;align-items:center;gap:6px;max-width:230px;height:26px;padding:0 10px;border:1px solid var(--wb-hairline);border-radius:13px;background:var(--wb-surface);color:var(--wb-text);font:11px/1 "Segoe UI Variable Text","Segoe UI Variable","Segoe UI","Microsoft YaHei UI","Microsoft YaHei",sans-serif;white-space:nowrap;box-shadow:var(--wb-shadow),0 0 0 1px var(--wb-stroke);-webkit-backdrop-filter:blur(24px) saturate(1.6);backdrop-filter:blur(24px) saturate(1.6);pointer-events:none;visibility:hidden}
.wb-toast.wb-show{visibility:visible}
.wb-toast::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--wb-accent)}
.wb-toast::after{content:attr(data-label);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.wb-toast.wb-ok{color:var(--wb-ok-fg)}
.wb-toast.wb-ok::before{background:var(--wb-ok-fg)}
.wb-toast.wb-err{color:var(--wb-err-fg)}
.wb-toast.wb-err::before{background:var(--wb-err-fg)}
@media (prefers-reduced-motion:reduce){#${PANEL_ID} *,#${PANEL_ID}{transition:none!important}}
`;
    root.appendChild(style);
  }

  // display:contents 让宿主不生成布局盒子、不占文档流，也不创建定位包含块；
  // Shadow DOM 里的 #wb-bili-like-panel 依旧相对视口做 fixed 定位。
  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.display = 'contents';
  const shadow = host.attachShadow({ mode: 'closed' });
  injectStyle(shadow);
  document.body.appendChild(host);

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML = `
  <div class="wb-head"><span class="wb-title">点赞助手</span><button type="button" class="wb-close" data-label="×" title="关闭"></button></div>
  <div class="wb-body">
    <div class="wb-row"><label>次数</label><input id="wb-times" type="number" min="1" max="100" value="10"></div>
    <div class="wb-row"><label>每次</label><input id="wb-per" type="number" min="1" max="300" value="30"></div>
    <div class="wb-row"><label>间隔 ms</label><input id="wb-delay" type="number" min="200" step="100" value="1000"></div>
    <div class="wb-row"><label class="wb-check" title="自动点赞只作用于当前直播间，每个直播间分别记忆开关与参数"><input id="wb-auto" type="checkbox"> 自动<span class="wb-hint">仅本房</span></label></div>
    <div class="wb-today"><span id="wb-today">本房 0 / 300</span><button type="button" class="wb-link" id="wb-reset" title="只清本房配额进度，当日累计统计保留">重置</button></div>
    <div class="wb-total" id="wb-total" role="button" tabindex="0" aria-expanded="false" title="当日所有直播间点赞总数，点击展开逐房间明细"><span>全站今日 <b class="wb-total-num" id="wb-total-num">0</b> 赞 <span class="wb-total-caret">▼</span></span><span><b id="wb-total-rooms">0</b> 间</span></div>
    <div class="wb-total-list" id="wb-total-list" hidden></div>
    <div class="wb-btns"><button type="button" id="wb-start">开始</button><button type="button" id="wb-stop" disabled>停止</button></div>
    <div class="wb-status" id="wb-status">待机</div>
  </div>`;
  // 只挂进 Shadow Root：面板文字与样式都留在隔离树里，不会泄漏到页面正文
  shadow.appendChild(panel);

  // 运行状态胶囊：与面板平级、同在封闭 Shadow Root 内，只在任务期间短暂出现
  const toastEl = document.createElement('div');
  toastEl.className = 'wb-toast';
  toastEl.setAttribute('data-label', '');
  shadow.appendChild(toastEl);

  const $ = (selector) => panel.querySelector(selector);
  const statusEl = $('#wb-status');
  const startBtn = $('#wb-start');
  const stopBtn = $('#wb-stop');
  const closeBtn = $('.wb-close');
  const autoBox = $('#wb-auto');
  const todayEl = $('#wb-today');
  const totalBox = $('#wb-total');
  const totalNumEl = $('#wb-total-num');
  const totalRoomsEl = $('#wb-total-rooms');
  const totalListEl = $('#wb-total-list');
  const resetBtn = $('#wb-reset');

  let running = false;
  let stopFlag = false;
  let panelOpen = false;
  let toastTimer = null;

  // 面板默认隐藏，所以任务反馈要能独立显示：状态同时写进面板状态栏
  // 和贴在原生按钮上方的临时胶囊，胶囊数秒后自动消失，不留任何常驻 UI。
  function setStatus(text, kind, silent) {
    const k = kind || '';
    statusEl.textContent = text;
    statusEl.className = 'wb-status' + (k ? ' wb-' + k : '');
    if (silent || panelOpen) return;
    toastEl.setAttribute('data-label', text);
    toastEl.className = 'wb-toast wb-show' + (k ? ' wb-' + k : '');
    positionToast();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = 'wb-toast'; }, 3500);
  }

  const initial = readRoomInfo();
  setStatus(initial ? '待机' : '未识别房间', '', true);

  // ---------------------------------------------------------------------------
  // 原生按钮集成：没有自制图标、没有拖动、没有位置记忆，页面默认零常驻界面。
  // 事件挂在 document 捕获阶段做委托，Vue 重渲染 / SPA 切房后都无需重新绑定。
  // ---------------------------------------------------------------------------
  const EDGE_MIN = 8;
  const viewportWidth = () => window.innerWidth;
  const viewportHeight = () => window.innerHeight;

  // 定位时优先精确 class，再退到 data 属性（均来自真实页面 DOM）
  function nativeBtn() {
    return document.querySelector('.like-btn')
      || document.querySelector('[data-event-name="dianzan.0.show"]')
      || document.querySelector(NATIVE_LIKE_SELECTOR);
  }

  function closestNative(target) {
    if (!target || typeof target.closest !== 'function') return null;
    try { return target.closest(NATIVE_LIKE_SELECTOR); } catch (error) { return null; }
  }

  function anchorRect() {
    const btn = nativeBtn();
    if (!btn || typeof btn.getBoundingClientRect !== 'function') return null;
    const rect = btn.getBoundingClientRect();
    return (rect.width > 0 && rect.height > 0) ? rect : null;
  }

  // 浮层水平居中对齐原生按钮，优先摆在按钮上方；上方空间不够就翻到下方，并夹在视口内。
  function placeAbove(el, width, height) {
    const rect = anchorRect();
    if (!rect) return false;
    const W = viewportWidth();
    const H = viewportHeight();
    const left = Math.min(Math.max(EDGE_MIN, rect.left + rect.width / 2 - width / 2),
      Math.max(EDGE_MIN, W - width - EDGE_MIN));
    let top = rect.top - height - 8;
    if (top < EDGE_MIN) top = Math.min(rect.bottom + 8, Math.max(EDGE_MIN, H - height - EDGE_MIN));
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    return true;
  }

  function positionPanel() {
    if (panelOpen) placeAbove(panel, panel.offsetWidth, panel.offsetHeight);
  }

  function positionToast() {
    const rect = anchorRect();
    if (!rect) { toastEl.className = 'wb-toast'; return; }
    const W = viewportWidth();
    const width = Math.min(230, W - EDGE_MIN * 2);
    // 面板开着时把胶囊挪到面板上方，两块浮层不重叠
    const offset = panelOpen ? panel.offsetHeight + 6 : 0;
    const left = Math.min(Math.max(EDGE_MIN, rect.left + rect.width / 2 - width / 2),
      Math.max(EDGE_MIN, W - width - EDGE_MIN));
    const top = Math.max(EDGE_MIN, rect.top - 26 - 8 - offset);
    toastEl.style.left = left + 'px';
    toastEl.style.top = top + 'px';
  }

  function hideToast() {
    clearTimeout(toastTimer);
    toastEl.className = 'wb-toast';
  }

  function showPanel() {
    panelOpen = true;
    panel.classList.add('wb-open');
    hideToast();
    // 先刷新内容再定位：明细展开会改变面板高度，按旧高度定位会偏
    refreshPanelState();
    positionPanel();
  }

  function hidePanel() {
    panelOpen = false;
    panel.classList.remove('wb-open');
  }

  function togglePanel() {
    if (panelOpen) hidePanel(); else showPanel();
  }

  // 左键：不阻止默认、不阻止冒泡，原生 +1 照常发生，同时启动脚本的批量点赞。
  // 按下修饰键时不接管，避免影响 Ctrl+点击等浏览器行为。
  document.addEventListener('click', (event) => {
    if (event.button !== 0 || event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
    if (!closestNative(event.target)) return;
    if (CLICK_ACTION === 'batch') run();
    else togglePanel();
  }, true);

  // 右键：弹出紧贴按钮的设置面板（不可拖动、不记位置）
  document.addEventListener('contextmenu', (event) => {
    if (!closestNative(event.target)) return;
    event.preventDefault();
    showPanel();
  }, true);

  // 面板内的点击不冒泡到 document，否则会被「点外部关闭」误判
  panel.addEventListener('click', (event) => event.stopPropagation());
  closeBtn.addEventListener('click', hidePanel);

  document.addEventListener('click', (event) => {
    if (!panelOpen) return;
    if (closestNative(event.target)) return; // 原生按钮交给上面的捕获监听
    hidePanel();
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && panelOpen) hidePanel();
  }, true);

  window.addEventListener('resize', () => { positionPanel(); positionToast(); });
  window.addEventListener('scroll', () => { positionPanel(); positionToast(); }, true);

  // ---------------------------------------------------------------------------
  // 参数按直播间隔离：defaults 是未单独设置过的房间的默认值，byRoom[URL房间号] 覆盖它。
  // 每次保存都先重读 localStorage 再写回，避免多个直播间标签页互相覆盖别的房间设置。
  // ---------------------------------------------------------------------------
  function readJson(key, fallback) {
    try {
      const parsed = JSON.parse(localStorage.getItem(key) || 'null');
      return (parsed && typeof parsed === 'object') ? parsed : fallback;
    } catch (error) {
      return fallback;
    }
  }

  // ---------------------------------------------------------------------------
  // 主播昵称：统计里给房间号配上主播名，换直播间后也能一眼认出是哪个房间。
  // 优先读页面自带的房间初始化数据（零请求），拿不到再查官方只读接口；
  // 昵称长期缓存在 localStorage，同一房间只查一次，刷新 / 换天都不重复请求。
  // ---------------------------------------------------------------------------
  const nameCache = readJson(NAMES_KEY, {}) || {};
  const nameTried = {};   // 本次会话内已尝试过的房间：查不到也不再反复请求
  const namePending = {}; // 同一房间并发渲染时复用同一个请求

  function cleanName(value) {
    return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 24) : '';
  }

  function roomName(roomId) {
    return roomId ? (nameCache[roomId] || '') : '';
  }

  function saveName(roomId, uname) {
    const name = cleanName(uname);
    if (!roomId || !name || nameCache[roomId] === name) return name;
    nameCache[roomId] = name;
    try {
      localStorage.setItem(NAMES_KEY, JSON.stringify(nameCache));
    } catch (error) {
      console.warn('[点赞助手] 保存主播昵称失败', error);
    }
    return name;
  }

  // 页面初始化数据里就带主播昵称，命中时完全不发请求
  function anchorNameFromPage(roomId) {
    try {
      const state = page.__SSR_INITIAL_STATE__;
      if (roomId && state && state.baseInfoRoom) {
        const roomIdInPage = (state.baseInfoRoom.room_info || {}).room_id;
        const base = (state.baseInfoRoom.anchor_info || {}).base_info || {};
        if (String(roomIdInPage || '') === String(roomId) && base.uname) return cleanName(base.uname);
      }
    } catch (error) {
      // 页面结构变化时忽略，交给接口兜底
    }
    return '';
  }

  async function fetchAnchorName(roomId) {
    try {
      const response = await fetchWithTimeout(
        'https://api.live.bilibili.com/live_user/v1/UserInfo/get_anchor_in_room?roomid=' + encodeURIComponent(roomId),
        { credentials: 'include' },
        8000
      );
      const json = await response.json();
      const info = json && json.data && json.data.info;
      if (json && json.code === 0 && info && info.uname) return cleanName(info.uname);
    } catch (error) {
      console.warn('[点赞助手] 主播昵称查询失败', error);
    }
    return '';
  }

  function loadAnchorName(roomId) {
    if (!roomId) return Promise.resolve('');
    if (nameCache[roomId]) return Promise.resolve(nameCache[roomId]);
    const fromPage = anchorNameFromPage(roomId);
    if (fromPage) {
      saveName(roomId, fromPage);
      return Promise.resolve(fromPage);
    }
    if (nameTried[roomId]) return Promise.resolve('');
    nameTried[roomId] = true;
    if (!namePending[roomId]) {
      namePending[roomId] = fetchAnchorName(roomId).then((name) => {
        delete namePending[roomId];
        if (name) saveName(roomId, name);
        return name;
      });
    }
    return namePending[roomId];
  }

  function readConfig() {
    const raw = readJson(CFG_KEY, {}) || {};
    // 兼容 v2.0 的扁平格式 {times, per, delay}，升级后作为全局默认值
    const base = (raw.byRoom && raw.defaults && typeof raw.defaults === 'object') ? raw.defaults : raw;
    const defaults = Object.assign({}, DEFAULT_CFG);
    ['times', 'per', 'delay'].forEach((key) => {
      if (base[key] != null && base[key] !== '') defaults[key] = String(base[key]);
    });
    const byRoom = (raw.byRoom && typeof raw.byRoom === 'object') ? raw.byRoom : {};
    return { defaults, byRoom };
  }

  function configFor(room) {
    const cfg = readConfig();
    const saved = (room && cfg.byRoom[room] && typeof cfg.byRoom[room] === 'object') ? cfg.byRoom[room] : {};
    const merged = Object.assign({}, cfg.defaults);
    ['times', 'per', 'delay'].forEach((key) => {
      if (saved[key] != null && saved[key] !== '') merged[key] = String(saved[key]);
    });
    return merged;
  }

  function applyConfig(room) {
    const value = configFor(room);
    $('#wb-times').value = value.times;
    $('#wb-per').value = value.per;
    $('#wb-delay').value = value.delay;
  }

  function saveConfig() {
    const room = roomIdFromUrl();
    if (!room) return;
    try {
      const cfg = readConfig();
      cfg.byRoom[room] = {
        times: $('#wb-times').value,
        per: $('#wb-per').value,
        delay: $('#wb-delay').value
      };
      localStorage.setItem(CFG_KEY, JSON.stringify({ v: 2, defaults: cfg.defaults, byRoom: cfg.byRoom }));
    } catch (error) {
      console.warn('[点赞助手] 保存参数失败', error);
    }
  }

  applyConfig(roomIdFromUrl());
  ['#wb-times', '#wb-per', '#wb-delay'].forEach((selector) => {
    $(selector).addEventListener('change', saveConfig);
  });

  console.log('[点赞助手] 已集成到原生点赞按钮：左键=自动完成一批点赞，右键=打开设置面板');

  // ---------------------------------------------------------------------------
  // 自动任务：开关按「URL 房间号」分别记忆，未单独设置过的房间沿用 defaultEnabled
  // （即旧版全局开关迁移来的默认值）。参数同样按房间隔离，互不干扰。
  // 每日记录独立存 RECORD_KEY = {date, rooms:{roomId:{used,total}}}，跨天自动归零。
  // used  = 本房当日「配额已用」次数，只用于 300 上限判断，点重置后归零（可以重新点）；
  // total = 本房当日「实际成功点赞」次数，只增不减，重置不清空，用于全站累计统计。
  // 拆开存的原因：重置是「解除本房上限、允许继续点」，不代表之前点过的赞没发生；
  // 若两者共用同一个数字，重置就会把当日累计一起抹掉，重刷后汇总永远回不到 600。
  // 2026-05 亲密度规则：每 30 赞 +1，每日上限 10 次，即每房间每天 300 有效赞。
  // ---------------------------------------------------------------------------
  const AUTO_SCHEMA = 4;

  function todayKey() {
    const date = new Date();
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  // 兼容三种历史格式：数字（≤v2.2.1）、{used,total}（当前）、残缺对象。
  // 旧数据只有一个数字时无法区分「重置过没有」，只能按 used=min(n,300)、total=n 读入，
  // 这样升级后既不会把已用配额算少（重复刷 300），也不会把当日累计算少。
  function normalizeRoomRecord(value) {
    if (value == null) return null;
    if (typeof value === 'object') {
      const hasUsed = value.used != null && value.used !== '' && Number.isFinite(Number(value.used));
      const hasTotal = value.total != null && value.total !== '' && Number.isFinite(Number(value.total));
      const usedBase = hasUsed ? Math.floor(Number(value.used)) : null;
      const totalBase = hasTotal ? Math.floor(Number(value.total)) : usedBase;
      if (totalBase == null) return null;
      // used 缺失时按 total 补齐（保守：宁可当成已用完配额，也不要重复刷）
      const safeUsed = Math.min(DAILY_LIMIT, Math.max(0, usedBase == null ? totalBase : usedBase));
      const safeTotal = Math.max(safeUsed, Math.max(0, totalBase));
      return (safeTotal > 0) ? { used: safeUsed, total: safeTotal } : null;
    }
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return null;
    const total = Math.floor(n);
    return { used: Math.min(DAILY_LIMIT, total), total };
  }

  function todayRecords() {
    const raw = readJson(RECORD_KEY, {}) || {};
    const source = (raw.date === todayKey() && raw.rooms && typeof raw.rooms === 'object') ? raw.rooms : {};
    const rooms = {};
    Object.keys(source).forEach((room) => {
      const record = normalizeRoomRecord(source[room]);
      if (record) rooms[room] = record;
    });
    return { date: todayKey(), rooms };
  }

  function readAutoSettings() {
    const raw = readJson(AUTO_KEY, {}) || {};
    if (raw.schema !== AUTO_SCHEMA || !raw.enabledByRoom || typeof raw.enabledByRoom !== 'object') {
      return { defaultEnabled: false, enabledByRoom: {} };
    }
    const enabledByRoom = {};
    Object.keys(raw.enabledByRoom).forEach((room) => {
      if (typeof raw.enabledByRoom[room] === 'boolean') enabledByRoom[room] = raw.enabledByRoom[room];
    });
    return { defaultEnabled: raw.defaultEnabled === true, enabledByRoom };
  }

  // v2.0 及更早的 AUTO_KEY 里同时存了全局 enabled 与 {roomId:{date,reported}}。
  // 升级时保留当日已上报数，避免迁移后把 300 赞重复刷一遍；旧全局开关变成「未设置房间的默认值」。
  function migrateAuto() {
    const raw = readJson(AUTO_KEY, {}) || {};
    if (raw.schema === AUTO_SCHEMA) return;
    const legacy = (raw.records && typeof raw.records === 'object') ? raw.records : {};
    // 与已存在的当日记录合并而不是覆盖：用户只清过 AUTO_KEY 时，不能把今天的已点赞数抹掉
    const existing = readJson(RECORD_KEY, {}) || {};
    const rooms = (existing.date === todayKey() && existing.rooms && typeof existing.rooms === 'object')
      ? Object.assign({}, existing.rooms) : {};
    Object.keys(legacy).forEach((room) => {
      const record = legacy[room];
      if (record && record.date === todayKey() && Number.isFinite(record.reported) && record.reported > 0) {
        const prev = normalizeRoomRecord(rooms[room]);
        const legacyTotal = Math.min(DAILY_LIMIT, Math.floor(record.reported));
        // 迁移时 used / total 取同一个数：旧格式里没有「重置过」的信息可依
        const total = Math.max(prev ? prev.total : 0, legacyTotal);
        rooms[room] = { used: Math.min(DAILY_LIMIT, total), total };
      }
    });
    try {
      localStorage.setItem(RECORD_KEY, JSON.stringify({ date: todayKey(), rooms }));
      localStorage.setItem(AUTO_KEY, JSON.stringify({
        schema: AUTO_SCHEMA,
        defaultEnabled: raw.enabled === true,
        enabledByRoom: {}
      }));
      console.log('[点赞助手] 已升级：自动开关按直播间独立记忆，当日已点赞记录已保留');
    } catch (error) {
      console.warn('[点赞助手] 升级自动设置失败', error);
    }
  }

  const autoState = {
    defaultEnabled: false,
    enabledByRoom: {},
    records: { date: todayKey(), rooms: {} }
  };

  migrateAuto();
  (function loadAutoState() {
    const settings = readAutoSettings();
    autoState.defaultEnabled = settings.defaultEnabled;
    autoState.enabledByRoom = settings.enabledByRoom;
    autoState.records = todayRecords();
  })();

  function autoEnabled(room) {
    if (!room) return false;
    const value = autoState.enabledByRoom[room];
    return typeof value === 'boolean' ? value : autoState.defaultEnabled;
  }

  // 每次都重读 localStorage 再写回：多个直播间标签页同时改开关时只覆盖自己那个房间
  function setRoomAuto(room, enabled) {
    if (!room) return;
    const settings = readAutoSettings();
    settings.enabledByRoom[room] = enabled;
    try {
      localStorage.setItem(AUTO_KEY, JSON.stringify({
        schema: AUTO_SCHEMA,
        defaultEnabled: settings.defaultEnabled,
        enabledByRoom: settings.enabledByRoom
      }));
    } catch (error) {
      console.warn('[点赞助手] 保存自动开关失败', error);
    }
    autoState.defaultEnabled = settings.defaultEnabled;
    autoState.enabledByRoom = settings.enabledByRoom;
  }

  // 本房配额已用（上限判断 / 进度条用）
  function reportedToday(roomId) {
    if (!roomId || autoState.records.date !== todayKey()) return 0;
    const record = normalizeRoomRecord(autoState.records.rooms[roomId]);
    return record ? record.used : 0;
  }

  // 本房当日实际累计（全站统计 / 明细用，不因重置减少）
  function totalToday(roomId) {
    if (!roomId || autoState.records.date !== todayKey()) return 0;
    const record = normalizeRoomRecord(autoState.records.rooms[roomId]);
    return record ? record.total : 0;
  }

  // 重读后再累加：不覆盖别的标签页刚写入的其他直播间记录，全站总数才不会丢
  function addReported(roomId, count) {
    const fresh = todayRecords();
    const prev = fresh.rooms[roomId] || { used: 0, total: 0 };
    // used 封顶 300（配额），total 不封顶：重置后继续点会一直累加
    fresh.rooms[roomId] = {
      used: Math.min(DAILY_LIMIT, prev.used + count),
      total: prev.total + count
    };
    try {
      localStorage.setItem(RECORD_KEY, JSON.stringify(fresh));
    } catch (error) {
      console.warn('[点赞助手] 保存点赞记录失败', error);
    }
    autoState.records = fresh;
    updateTodayLabel(roomId);
  }

  // 重置只清「本房配额进度」，当日实际累计 total 保留：
  // 之后重新点 300，全站汇总应继续累加到 600，而不是被打回 300。
  function clearRoomRecord(roomId) {
    const fresh = todayRecords();
    const prev = fresh.rooms[roomId];
    if (prev && prev.total > 0) fresh.rooms[roomId] = { used: 0, total: prev.total };
    else delete fresh.rooms[roomId];
    try {
      localStorage.setItem(RECORD_KEY, JSON.stringify(fresh));
    } catch (error) {
      console.warn('[点赞助手] 重置点赞记录失败', error);
    }
    autoState.records = fresh;
  }

  function dailyTotals() {
    const rooms = autoState.records.date === todayKey() ? autoState.records.rooms : {};
    const rows = [];
    let total = 0;
    Object.keys(rooms).forEach((room) => {
      const record = normalizeRoomRecord(rooms[room]);
      // 按「实际累计」统计，而不是配额进度：重置过配额但点过赞的房间仍留在汇总里
      if (record && record.total > 0) {
        total += record.total;
        rows.push({ roomId: room, count: record.total, used: record.used, name: roomName(room) });
      }
    });
    // 赞数多的排前面；同赞数按房间号排序，保证每次打开顺序稳定
    rows.sort((a, b) => (b.count - a.count) || (a.roomId < b.roomId ? -1 : 1));
    const details = rows.map((row) => (row.name ? row.name + '（' + row.roomId + '）' : row.roomId) + '：' + row.count + ' 赞');
    return { total, rooms: rows.length, rows, details };
  }

  // 逐房间明细列表：一行一个直播间，主播名在前、房间号紧随其后
  let totalExpanded = false;

  function renderTotal(stat, currentRoom) {
    totalNumEl.textContent = String(stat.total);
    totalRoomsEl.textContent = String(stat.rooms);
    totalBox.title = stat.rooms
      ? '当日全站 ' + stat.total + ' 赞 · ' + stat.rooms + ' 个直播间\n' + stat.details.join('\n')
      : '当日所有直播间点赞总数';
    totalBox.setAttribute('aria-expanded', totalExpanded ? 'true' : 'false');
    panel.classList.toggle('wb-wide', totalExpanded);

    if (!totalExpanded) {
      totalListEl.hidden = true;
      totalListEl.textContent = '';
      return;
    }
    totalListEl.hidden = false;
    const frag = document.createDocumentFragment();
    const rows = stat.rows;
    if (!rows.length) {
      const empty = document.createElement('div');
      empty.className = 'wb-total-empty';
      empty.textContent = '今天还没有点赞记录';
      frag.appendChild(empty);
    }
    rows.forEach((row) => {
      const item = document.createElement('div');
      item.className = 'wb-total-item' + (currentRoom && row.roomId === currentRoom ? ' wb-cur' : '');
      // 明细里的数字是「当日实际累计」；曾重置过配额时，tooltip 补上当前配额进度便于对照
      item.title = (row.name || '未知主播') + ' · 房间号 ' + row.roomId + ' · 当日累计 ' + row.count + ' 赞'
        + '（本房配额 ' + row.used + ' / ' + DAILY_LIMIT + '）';
      const main = document.createElement('span');
      main.className = 'wb-ti-main';
      const nameEl = document.createElement('span');
      nameEl.className = 'wb-ti-name';
      nameEl.textContent = row.name || '房间 ' + row.roomId;
      main.appendChild(nameEl);
      // 名字拿不到时上面已经写了房间号，就不再重复一遍
      if (row.name) {
        const idEl = document.createElement('span');
        idEl.className = 'wb-ti-id';
        idEl.textContent = row.roomId;
        main.appendChild(idEl);
      }
      const numEl = document.createElement('span');
      numEl.className = 'wb-ti-num';
      numEl.textContent = row.count + ' 赞';
      item.appendChild(main);
      item.appendChild(numEl);
      frag.appendChild(item);
    });
    totalListEl.textContent = '';
    totalListEl.appendChild(frag);
  }

  function updateTodayLabel(roomId) {
    const room = roomId || roomIdFromUrl() || (readRoomInfo() || {}).roomId;
    const done = room ? reportedToday(room) : 0;
    todayEl.textContent = '本房 ' + done + ' / ' + DAILY_LIMIT + (done >= DAILY_LIMIT ? ' · 已完成' : '');
    // 进度条只写 CSS 变量：不加 DOM、不改高度，面板尺寸测量不受影响
    const todayBox = todayEl.parentElement;
    if (todayBox && todayBox.style && todayBox.style.setProperty) {
      todayBox.style.setProperty('--wb-progress', String(Math.min(1, done / DAILY_LIMIT)));
    }

    // 当日全站累计：所有直播间已成功上报的赞数总和 + 逐房间明细（主播名 / 房间号）
    const stat = dailyTotals();
    renderTotal(stat, room);

    // 昵称是异步补的：先按房间号显示，拿到名字后再刷一次（每房间只查一次，不会循环）
    if (room && !roomName(room)) {
      loadAnchorName(room).then((name) => {
        if (name) updateTodayLabel(room);
      });
    }
    // 明细展开时，把还没名字的历史房间也补上（最多同时补 5 个，失败不重试）
    if (totalExpanded) {
      const missing = stat.rows.filter((row) => !row.name && !nameTried[row.roomId]).slice(0, 5);
      if (missing.length) {
        Promise.all(missing.map((row) => loadAnchorName(row.roomId))).then((names) => {
          if (names.some(Boolean)) updateTodayLabel(room);
        });
      }
    }
  }

  // 点统计行展开 / 收起逐房间明细；面板高度变了要重新贴回按钮上方
  function toggleTotalDetail() {
    totalExpanded = !totalExpanded;
    updateTodayLabel(roomIdFromUrl());
    positionPanel();
  }
  totalBox.addEventListener('click', toggleTotalDetail);
  totalBox.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      toggleTotalDetail();
    }
  });

  // 打开面板时只刷新显示，不回填输入框，避免覆盖用户正在编辑但还没失焦的值
  function refreshPanelState() {
    autoBox.checked = autoEnabled(roomIdFromUrl());
    updateTodayLabel(roomIdFromUrl());
  }

  // 切换直播间时把 UI 切到该房间自己的设置；直接赋值不触发 change，不会写脏数据
  function syncRoomUi(room) {
    autoBox.checked = autoEnabled(room);
    applyConfig(room);
    updateTodayLabel(room);
  }

  autoBox.addEventListener('change', () => {
    const room = roomIdFromUrl();
    setRoomAuto(room, autoBox.checked);
    setStatus((autoBox.checked ? '自动已开启' : '自动已关闭') + '（仅本房）');
    if (autoBox.checked && room && !running) scheduleAuto(0);
  });

  resetBtn.addEventListener('click', () => {
    const room = roomIdFromUrl();
    if (!room) return;
    // 重置的是「配额进度」：可以继续点，但当天已经点过的赞仍算在汇总里
    const kept = totalToday(room);
    clearRoomRecord(room);
    updateTodayLabel(room);
    setStatus(kept > 0 ? '本房配额已重置 · 当日累计 ' + kept + ' 赞保留' : '本房记录已重置');
  });

  // 其他直播间标签页改了开关或刷了赞，本页即时同步显示
  window.addEventListener('storage', (event) => {
    if (event.key === RECORD_KEY) {
      autoState.records = todayRecords();
      updateTodayLabel(roomIdFromUrl());
    } else if (event.key === AUTO_KEY) {
      const settings = readAutoSettings();
      autoState.defaultEnabled = settings.defaultEnabled;
      autoState.enabledByRoom = settings.enabledByRoom;
      autoBox.checked = autoEnabled(roomIdFromUrl());
    }
  });

  syncRoomUi(roomIdFromUrl());

  stopBtn.addEventListener('click', () => {
    if (!running) return;
    stopFlag = true;
    setStatus('正在停止…');
  });

  startBtn.addEventListener('click', run);

  // 每次任务都重新解析当前房间，杜绝 SPA 切房后把赞报到旧房间
  async function prepare() {
    const csrf = getCookie('bili_jct');
    const uid = getCookie('DedeUserID');
    if (!csrf || !uid) {
      setStatus('未登录：缺少 bili_jct 或 DedeUserID', 'err');
      return null;
    }

    const room = await resolveRoom();
    if (!room) {
      setStatus('无法解析当前直播间，请确认在直播间页面', 'err');
      return null;
    }
    if (!room.anchorId) {
      setStatus('无法获取主播 UID，已中止', 'err');
      return null;
    }

    const liveText = describeLiveStatus(room.liveStatus);
    console.log('[点赞助手] 房间 ' + room.recordKey + ' · room_id=' + room.roomId
      + ' · 主播 ' + room.anchorId + ' · ' + liveText);

    // B 站规则：只有直播中(1)点赞才有效。未开播/轮播时前端仍会显示 +1，但刷新后回退。
    if (room.liveStatus != null && room.liveStatus !== 1) {
      const reason = '直播间' + liveText + '，B 站规则下点赞不计入，已跳过';
      setStatus(reason, 'err');
      console.warn('[点赞助手] ' + reason);
      return null;
    }
    setStatus('准备上报');
    updateTodayLabel(room.recordKey);
    return {
      roomId: room.roomId,
      recordKey: room.recordKey,
      anchorId: room.anchorId,
      liveStatus: room.liveStatus,
      uid,
      csrf
    };
  }

  // 手动任务与自动任务共用；只有接口返回 code=0 才计入当日进度
  async function runBatch(ctx, targetTotal, per, delay, label) {
    if (running) return; // 并发时只放行一个
    running = true;
    stopFlag = false;
    startBtn.disabled = true;
    stopBtn.disabled = false;

    let sent = 0;
    let ok = 0;
    let fail = 0;
    let lastError = '';
    let consecutiveFailures = 0;
    const maxAttempts = Math.ceil(targetTotal / per) + 3;
    console.log('[点赞助手] ' + label + '开始：URL房间 ' + ctx.recordKey + ' → room_id ' + ctx.roomId
      + '，anchor_id ' + ctx.anchorId + '，目标 ' + targetTotal + ' 赞，每次最多 ' + per + '，间隔 ' + delay + 'ms');

    try {
      for (let i = 1; i <= maxAttempts && sent < targetTotal && !stopFlag; i++) {
        const clickTime = Math.min(per, targetTotal - sent);
        try {
          await reportLike({ roomId: ctx.roomId, anchorId: ctx.anchorId, uid: ctx.uid, csrf: ctx.csrf, clickTime });
          sent += clickTime;
          ok++;
          consecutiveFailures = 0;
          addReported(ctx.recordKey, clickTime);
          setStatus(label + ' ' + sent + '/' + targetTotal + ' 赞 · 本房配额 ' + reportedToday(ctx.recordKey) + '/' + DAILY_LIMIT, 'ok');
          console.log('[点赞助手] 第 ' + i + ' 次上报完成（+' + clickTime + '）');
        } catch (error) {
          fail++;
          lastError = error.message;
          consecutiveFailures++;
          setStatus(label + ' 第 ' + i + ' 次失败：' + error.message, 'err');
          console.warn('[点赞助手] 第 ' + i + ' 次失败', error);
        }
        // 接口不通时不再连发几十次无效请求，尽快把原因反馈给用户
        if (consecutiveFailures >= 3) break;
        if (sent < targetTotal && !stopFlag && i < maxAttempts) await sleep(delay);
      }
      const aborted = consecutiveFailures >= 3;
      // 汇总会覆盖逐次状态，失败时必须把具体原因留在状态栏，否则只看得到「成功 0 / 失败 N」
      const summary = (stopFlag ? '已停止' : aborted ? '因连续失败中止' : '完成') + '：成功 ' + ok + ' / 失败 ' + fail
        + ' · 本次 ' + sent + ' 赞 · 本房配额 ' + reportedToday(ctx.recordKey) + '/' + DAILY_LIMIT
        + ' · 当日累计 ' + totalToday(ctx.recordKey)
        + (fail && lastError ? ' · 最后错误：' + lastError : '');
      setStatus(summary, fail ? 'err' : 'ok');
      console.log('[点赞助手] ' + label + summary);
    } finally {
      // 正常结束、异常、切房打断，都必须释放并发锁
      running = false;
      startBtn.disabled = false;
      stopBtn.disabled = true;
    }
  }

  async function run() {
    if (running) return;
    const ctx = await prepare();
    if (!ctx) return;
    const times = clamp($('#wb-times').value, 1, 100, 10);
    const per = clamp($('#wb-per').value, 1, 300, 30);
    const delay = clamp($('#wb-delay').value, 200, 60000, 1000);
    const remaining = DAILY_LIMIT - reportedToday(ctx.recordKey);
    if (remaining <= 0) {
      // 重置只清配额进度、不会清掉当日累计，所以这里可以放心引导用户去点重置
      setStatus('今日已达 ' + DAILY_LIMIT + ' 赞上限，可点「重置」继续', 'err');
      return;
    }
    // 手动任务也不越过当日上限，避免多发无效请求
    await runBatch(ctx, Math.min(times * per, remaining), per, delay, '手动');
  }

  async function runAuto() {
    const room = roomIdFromUrl();
    if (running || !room || !autoEnabled(room)) return; // 只对该直播间自己开启的自动开关生效

    const ctx = await prepare();
    if (!ctx) return;
    const remaining = DAILY_LIMIT - reportedToday(ctx.recordKey);
    if (remaining <= 0) {
      setStatus('今日已完成 ' + DAILY_LIMIT + ' 赞，自动任务跳过');
      console.log('[点赞助手] 房间 ' + ctx.recordKey + ' 今日已完成，跳过自动任务');
      return;
    }
    const per = clamp($('#wb-per').value, 1, 300, 30);
    const delay = clamp($('#wb-delay').value, 200, 60000, 1000);
    await runBatch(ctx, remaining, per, delay, '自动');
  }

  // 切房时上一房间任务若尚未结束，排队重试而不是直接放弃
  function scheduleAuto(attempt) {
    const n = attempt || 0;
    setTimeout(() => {
      const room = roomIdFromUrl();
      if (!room || !autoEnabled(room)) return;
      if (running) {
        if (n < 10) scheduleAuto(n + 1);
        return;
      }
      runAuto();
    }, n === 0 ? 1200 : 700);
  }

  if (autoEnabled(roomIdFromUrl())) scheduleAuto(0);

  let lastPath = location.pathname;
  setInterval(() => {
    cleanupStaleDom();
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;

    const urlRoom = roomIdFromUrl();
    // 切房时把自动开关、次数/每次/间隔、本房进度与全站总数一起切到新房间的设置
    syncRoomUi(urlRoom);
    setStatus(urlRoom ? '待机' : '未进入直播间', '', true);
    // 切房后 Vue 会重建聊天栏，浮层按新按钮矩形重新对齐（事件是委托的，无需重绑）
    positionPanel();
    positionToast();

    // 立刻停掉上一房间的残留任务，避免它继续占用并发锁
    if (running) {
      stopFlag = true;
      console.log('[点赞助手] 检测到切换直播间，停止上一房间任务');
    }
    if (urlRoom && autoEnabled(urlRoom)) scheduleAuto(0);
  }, 1000);
})();
