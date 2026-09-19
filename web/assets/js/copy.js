(function(){
'use strict';

var blocks = document.querySelectorAll('.doc-pre');
if (!blocks.length) return;

var LABEL = '复制';
var DONE = '已复制';
var FAIL = '复制失败';

var ICON = '<svg class="doc-copy__ico" viewBox="0 0 14 14" aria-hidden="true">'
         + '<rect x="5.2" y="5.2" width="7.3" height="7.3"/>'
         + '<path d="M8.8 5.2V1.5H1.5v7.3h3.7"/></svg>';

function legacyCopy(text){
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '-2000px';
  document.body.appendChild(ta);
  ta.select();
  var ok = false;
  try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
  document.body.removeChild(ta);
  return ok ? Promise.resolve() : Promise.reject(new Error('copy failed'));
}

function copy(text){
  var p = (navigator.clipboard && navigator.clipboard.writeText)
        ? navigator.clipboard.writeText(text)
        : Promise.reject(new Error('no clipboard api'));
  return p.catch(function(){ return legacyCopy(text); });
}

Array.prototype.forEach.call(blocks, function(pre){
  var code = pre.querySelector('code');
  if (!code) return;

  var wrap = document.createElement('div');
  wrap.className = 'doc-pre-wrap';
  pre.parentNode.insertBefore(wrap, pre);
  wrap.appendChild(pre);

  var btn = document.createElement('button');
  btn.className = 'doc-copy';
  btn.type = 'button';
  btn.setAttribute('aria-label', '复制代码');
  btn.innerHTML = ICON + '<span class="doc-copy__label">' + LABEL + '</span>';
  wrap.appendChild(btn);

  var label = btn.querySelector('.doc-copy__label');
  var timer = 0;

  function flash(text, done){
    label.textContent = text;
    btn.classList.toggle('is-done', !!done);
    clearTimeout(timer);
    timer = setTimeout(function(){
      label.textContent = LABEL;
      btn.classList.remove('is-done');
    }, 1600);
  }

  btn.addEventListener('click', function(){
    var text = code.textContent.replace(/\r\n?/g, '\n').replace(/\s+$/, '');
    copy(text).then(function(){
      flash(DONE, true);
    }, function(){
      flash(FAIL, false);
    });
  });
});

})();
