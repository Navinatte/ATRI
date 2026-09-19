/* ============================================================
   ATRI-bot · 作品集「宝箱」（小游戏奖励）

   设计要点：

   ① **默认 hidden，由 JS 揭示**。反过来做（默认可见、JS 隐藏）会在
      每次进页时闪一下宝箱，锁定的人也会先瞄到一眼。

   ② **localStorage 只是「这台机器的这个浏览器玩过」**。它不跨设备、
      不跨浏览器，无痕/清缓存就没了。而且任何人打开 DevTools 写一个
      键值就能解锁 —— 当彩蛋可以，当权限不行。

   ③ **它挡不住音频文件本身**。静态站没有鉴权，assets/audios/ 下的
      文件任何人直接敲 URL 都能拿到。所以「解锁才显示」是体验设计，
      不是内容保护。真要不外流，得靠后端签发临时链接。

   ④ `preload="none"` + 锁定态不可见 ⇒ 没解锁的访客一个字节都不下载。

   ⑤ **下载走 fetch → Blob → object URL**，不是裸露的 `<a download>`。
      理由见下方那段注释 —— 一句话：`download` 属性只对同源资源生效。

   调试：
     ?debug=1  强制显示（也可用于本地开发）
     ?debug=0  强制隐藏（用来检查锁定态长什么样）
   ============================================================ */
(function(){
'use strict';

var reward = document.getElementById('reward');
if (!reward) return;

var STORE = 'atri_works_reward';   /* localStorage 键，将来改格式就换名字 */
var UNLOCKED = '1';

/* ⚠️ 上线前改成 false。
   为 true 时宝箱默认显示 —— 调试期不用每回先通关一遍小游戏。 */
var DEV_SHOW = true;

/* ── 存储：一律包 try ──────────────────────────────────────
   无痕模式、禁用 Cookie / 站点数据时，localStorage 的读写会抛异常。
   存储坏掉不该影响页面其它部分，所以当作「未解锁」继续往下走。 */
function readUnlocked(){
  try { return localStorage.getItem(STORE) === UNLOCKED; }
  catch (e) { return false; }
}
function writeUnlocked(){
  try { localStorage.setItem(STORE, UNLOCKED); return true; }
  catch (e) { return false; }
}
function clearUnlocked(){
  try { localStorage.removeItem(STORE); } catch (e) {}
}

/* ── 揭示 ───────────────────────────────────────────────── */
var revealed = false;
function reveal(){
  if (revealed) return;
  revealed = true;
  reward.hidden = false;
}

/* ?debug= 的取值：1/true/空 → 强制显示；0/false → 强制隐藏 */
var force = null;
if (location.search.indexOf('debug=') > -1){
  var v = /[?&]debug=([^&]*)/.exec(location.search);
  v = v ? v[1].toLowerCase() : '';
  force = !(v === '0' || v === 'false');
}

if (force === true) reveal();
else if (force === false) { /* 强制隐藏，什么都不做 */ }
else if (DEV_SHOW || readUnlocked()) reveal();

/* ── 播放器 ─────────────────────────────────────────────── */
var audio  = document.getElementById('rewardAudio');
var playBtn = document.getElementById('rewardPlay');
var box    = reward.querySelector('.reward');
var label  = playBtn && playBtn.querySelector('.reward__label');

function setPlaying(on){
  if (box) box.classList.toggle('is-playing', on);
  if (label) label.textContent = on ? '暂停' : '播放';
}

if (playBtn && audio){
  playBtn.addEventListener('click', function(){
    if (audio.paused){
      /* play() 返回 Promise；用户主动点的所以不会被自动播放策略拦，
         但换源失败、解码不支持时会 reject —— 兜住，别抛到控制台。 */
      var p = audio.play();
      if (p && p.catch) p.catch(function(){ setPlaying(false); });
    } else {
      audio.pause();
    }
  });

  audio.addEventListener('play',  function(){ setPlaying(true); });
  audio.addEventListener('pause', function(){ setPlaying(false); });
  audio.addEventListener('ended', function(){
    setPlaying(false);
    /* 回到开头，否则再按播放会立刻又结束 */
    try { audio.currentTime = 0; } catch (e) {}
  });
  audio.addEventListener('error', function(){
    if (label) label.textContent = '无法播放';
  });
}

/* ── 下载 ─────────────────────────────────────────────────
   为什么不用裸露的 `<a href="..." download>`：

   `download` 属性**只对同源资源生效**。不同源时浏览器会**静默忽略**它，
   直接导航过去 —— 访客看到的是一个音频播放界面，而不是「已保存」。
   而「同源」这件事不由我们控制：反向代理、内嵌 WebView、
   带域名重写的预览环境都可能把资源变成跨源。

   改成 fetch 取回 → 造 Blob → 用 object URL 触发保存：
   blob: URL **恒与页面同源**（不管原文件在哪），所以 download 一定生效；
   文件名也由我们写在 download 属性上，不依赖服务器或 URL 推断。

   没有 JS 时原来的 `<a href download>` 仍然在，功能不丢（渐进增强）。 */
var dlLink = document.querySelector('.reward .btn[download]');
if (dlLink){
  var dlLabel = dlLink.querySelector('span');
  var dlText  = dlLabel ? dlLabel.textContent : '';
  var dlBusy  = false;

  var say = function(t){ if (dlLabel) dlLabel.textContent = t; };
  var settle = function(t, ms){
    say(t);
    setTimeout(function(){ say(dlText); dlBusy = false;
                           dlLink.removeAttribute('aria-busy'); }, ms);
  };

  dlLink.addEventListener('click', function(ev){
    /* 连点两下会开出两个保存，拦掉 */
    if (dlBusy){ ev.preventDefault(); return; }
    /* 老环境没有 fetch / Blob / object URL：放行原生行为 */
    if (!window.fetch || !window.Blob || !window.URL || !URL.createObjectURL) return;
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

    ev.preventDefault();
    dlBusy = true;
    dlLink.setAttribute('aria-busy', 'true');

    var name = dlLink.getAttribute('download') || 'download.mp3';

    fetch(dlLink.href).then(function(res){
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (!res.body || !res.body.getReader) return res.blob();

      /* 边下边报进度：5 MB 在慢网上要等一会儿，
         不给反馈会让人以为点了没反应。 */
      var total  = +(res.headers.get('content-length') || 0);
      var reader = res.body.getReader();
      var parts  = [], got = 0;

      return (function pump(){
        return reader.read().then(function(r){
          if (r.done) return new Blob(parts, { type: 'audio/mpeg' });
          parts.push(r.value);
          got += r.value.length;
          say(total ? '下载中 ' + Math.round(got / total * 100) + '%' : '下载中');
          return pump();
        });
      })();

    }).then(function(blob){
      var href = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = href;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      /* 立刻 revoke 会让部分浏览器拿不到数据，留一拍
         （5 MB 的 blob，多留一会儿不碍事） */
      setTimeout(function(){ URL.revokeObjectURL(href); }, 10000);
      settle('已开始下载', 2000);

    }).catch(function(){
      /* 拿不到就明说，不要静默失败 */
      settle('下载失败', 2500);
    });
  });
}

/* ── 给以后的小游戏用的接口 ─────────────────────────────
   通关时调 window.atriWorksReward.unlock()。
   控制台里也能用：
     atriWorksReward.unlock()   解锁
     atriWorksReward.reset()    重置（回到锁定态）
     atriWorksReward.isUnlocked()
   unlock() 返回 false 表示「存不上」（无痕/禁用存储），
   但本次会话仍然解锁了。 */
window.atriWorksReward = {
  unlock: function(){ var ok = writeUnlocked(); reveal(); return ok; },
  isUnlocked: readUnlocked,
  reset: function(){
    if (audio && !audio.paused) audio.pause();
    setPlaying(false);
    clearUnlocked();
    reward.hidden = true;
    revealed = false;
  }
};

})();
