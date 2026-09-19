(function(){
'use strict';

var reward = document.getElementById('reward');
if (!reward) return;

var STORE = 'atri_works_reward';
var UNLOCKED = '1';

var DEV_SHOW = true;

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

var revealed = false;
function reveal(){
  if (revealed) return;
  revealed = true;
  reward.hidden = false;
}

var force = null;
if (location.search.indexOf('debug=') > -1){
  var v = /[?&]debug=([^&]*)/.exec(location.search);
  v = v ? v[1].toLowerCase() : '';
  force = !(v === '0' || v === 'false');
}

if (force === true) reveal();
else if (force === false) {  }
else if (DEV_SHOW || readUnlocked()) reveal();

var audio  = document.getElementById('rewardAudio');
var playBtn = document.getElementById('rewardPlay');
var box    = reward.querySelector('.reward');
var label  = playBtn && playBtn.querySelector('.reward__label');
var seek   = document.getElementById('rewardSeek');
var seekBar = document.querySelector('.reward__bar');
var subEl  = reward.querySelector('.reward__sub');
var subText = subEl ? subEl.textContent : '';

function setPlaying(on){
  if (box) box.classList.toggle('is-playing', on);
  if (label) label.textContent = on ? '暂停' : '播放';
}

function pad2(n){ return (n < 10 ? '0' : '') + n; }

function fmt(sec){
  sec = Math.max(0, Math.floor(sec || 0));
  var h = Math.floor(sec / 3600);
  var m = Math.floor(sec % 3600 / 60);
  var s = sec % 60;
  return (h ? h + ':' + pad2(m) : String(m)) + ':' + pad2(s);
}

function duration(){
  var d = audio ? audio.duration : NaN;
  return (isFinite(d) && d > 0) ? d : 0;
}

var scrubbing = false;
var seekBroken = false;
var brokenAt = 0;
var wantAt = null;

function paint(cur, dur){
  if (!subEl) return;
  if (!dur || !seek){
    subEl.textContent = subText;
    return;
  }
  var at = Math.min(Math.max(cur, 0), dur);
  if (seekBar) seekBar.style.setProperty('--p', (at / dur * 100) + '%');
  seek.setAttribute('aria-valuetext', fmt(at) + ' / ' + fmt(dur));
  subEl.textContent = fmt(at) + ' / ' + fmt(dur);
}

function seekableEnd(){
  var r = audio ? audio.seekable : null;
  if (!r || !r.length) return 0;
  try { return r.end(r.length - 1) || 0; } catch (e) { return 0; }
}

function markBroken(){
  seekBroken = true;
  brokenAt = seekableEnd();
}

function canSeek(){
  if (!audio || !duration()) return false;
  var end = seekableEnd();
  if (!end) return false;
  if (seekBroken){
    if (end > brokenAt + 1) seekBroken = false;
    else return false;
  }
  return true;
}

function syncMeta(){
  if (!seek) return;
  var d = duration();
  if (d) seek.max = String(d);
  seek.disabled = !canSeek();
  paint(scrubbing || wantAt !== null ? parseFloat(seek.value) : audio.currentTime, d);
}

function wireSeek(){
  if (!seek || !box) return;
  box.classList.add('is-live');
  paint(0, 0);

  ['loadedmetadata', 'durationchange', 'progress', 'canplay', 'playing']
    .forEach(function(ev){ audio.addEventListener(ev, syncMeta); });

  audio.addEventListener('seeked', function(){
    if (wantAt !== null){
      var off = Math.abs(audio.currentTime - wantAt);
      wantAt = null;
      if (off > 1) markBroken();
    }
    syncMeta();
  });

  audio.addEventListener('timeupdate', function(){
    var d = duration();
    if (scrubbing || !d) return;
    seek.value = String(audio.currentTime);
    paint(audio.currentTime, d);
  });

  seek.addEventListener('input', function(){
    var d = duration();
    if (!d || seek.disabled) return;
    scrubbing = true;
    paint(parseFloat(seek.value), d);
  });

  function commit(){
    if (!scrubbing) return;
    scrubbing = false;
    var d = duration();
    if (!d || seek.disabled) return;
    var at = parseFloat(seek.value);
    wantAt = at;
    try { audio.currentTime = at; } catch (e) { wantAt = null; }
    paint(at, d);
  }

  seek.addEventListener('change', commit);
  seek.addEventListener('pointerup', commit);
  seek.addEventListener('blur', commit);

  syncMeta();
}

if (playBtn && audio){
  playBtn.addEventListener('click', function(){
    if (audio.paused){
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
    try { audio.currentTime = 0; } catch (e) {}
    if (seek) seek.value = '0';
    paint(0, duration());
  });
  audio.addEventListener('error', function(){
    if (label) label.textContent = '无法播放';
    if (seek){
      markBroken();
      seek.disabled = true;
    }
    paint(0, 0);
  });

  wireSeek();
}

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
    if (dlBusy){ ev.preventDefault(); return; }
    if (!window.fetch || !window.Blob || !window.URL || !URL.createObjectURL) return;
    if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

    ev.preventDefault();
    dlBusy = true;
    dlLink.setAttribute('aria-busy', 'true');

    var name = dlLink.getAttribute('download') || 'download.mp3';

    fetch(dlLink.href).then(function(res){
      if (!res.ok) throw new Error('HTTP ' + res.status);
      if (!res.body || !res.body.getReader) return res.blob();

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
      setTimeout(function(){ URL.revokeObjectURL(href); }, 10000);
      settle('已开始下载', 2000);

    }).catch(function(){
      settle('下载失败', 2500);
    });
  });
}

window.atriWorksReward = {
  unlock: function(){ var ok = writeUnlocked(); reveal(); return ok; },
  isUnlocked: readUnlocked,
  reset: function(){
    if (audio && !audio.paused) audio.pause();
    setPlaying(false);
    scrubbing = false;
    wantAt = null;
    if (seek) seek.value = '0';
    if (seekBar) seekBar.style.setProperty('--p', '0%');
    paint(0, 0);
    clearUnlocked();
    reward.hidden = true;
    revealed = false;
  }
};

})();
