/* ============================================================
   ATRI-bot · 作品集画廊
   纯增强：整条画廊不依赖本文件也能用 ——
   `.gallery__track` 本身就是原生横向滚动容器，
   触摸 / 滚轮 / 聚焦后方向键都能翻页，滚动条也没被隐藏。
   本文件只做三件事：换成自绘控件、标记当前卡、让按钮能按。

   ⚠️ 位置一律用 getBoundingClientRect 算，不用 offsetLeft。
   容器的 offsetParent 不一定是 track（track 没有 position:relative），
   那样算出来的 offset 是相对别的祖先，判断「哪张在正中」就会错。
   ============================================================ */
(function(){
'use strict';

var gallery = document.getElementById('gallery');
var track   = document.getElementById('galleryTrack');
if (!gallery || !track) return;

var items = Array.prototype.slice.call(track.querySelectorAll('.gallery__item'));
if (!items.length) return;

var prevBtn = document.getElementById('galleryPrev');
var nextBtn = document.getElementById('galleryNext');
var nowEl   = document.getElementById('galleryNow');

var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var LAST = items.length - 1;

function pad2(n){ return (n < 9 ? '0' : '') + (n + 1); }

/* 当前卡 = 中心离滚动口中心最近的那张 */
function currentIndex(){
  var tr = track.getBoundingClientRect();
  var mid = tr.left + tr.width / 2;
  var best = 0, bestD = Infinity;
  for (var i = 0; i < items.length; i++){
    var r = items[i].getBoundingClientRect();
    var d = Math.abs(r.left + r.width / 2 - mid);
    if (d < bestD){ bestD = d; best = i; }
  }
  return best;
}

/* 翻到第 i 张。

   ⚠️ 曾经用 items[i].scrollIntoView({inline:'start'}) —— **在本环境下完全不动**。
   实测：容器的 scroll-padding-inline 算出来是未解析的
   `calc(0.5 * (100% - min(720px,100%)))`（不是 px），浏览器拿不到具体值，
   于是认定「这张卡已经整张在视口里」，scrollIntoView 就什么都不做。
   而直接赋 scrollLeft 也不行：在 scroll-snap-type:mandatory 下会被吸附搅乱
   （实测赋 568 会被拉到 0）。

   ⇒ 自己算目标位置，再用 scrollTo。这样既不依赖 scroll-padding 能不能被解析，
     也不依赖 offsetParent（不能用 offsetLeft：track 没有 position:relative，
     其 offsetParent 是别的祖先，算出来是错的）。

   公式：目标 = 当前位置 + （该卡现在离滚动口左缘多远） - （想让它离左缘多远）
         其中「想让它离左缘多远」=（口宽 - 卡宽）/2，即居中。 */
function goTo(i){
  i = Math.max(0, Math.min(LAST, i));
  var tr = track.getBoundingClientRect();
  var r  = items[i].getBoundingClientRect();
  /* clientLeft 是左边框宽；getBoundingClientRect 给的是边框盒，
     而被滚动的可视区是内边距盒，两者差一个边框。 */
  var origin = tr.left + track.clientLeft;
  var want   = (track.clientWidth - r.width) / 2;
  var left   = track.scrollLeft + (r.left - origin) - want;
  var instant = reduce;
  track.scrollTo({ left: Math.max(0, left), behavior: instant ? 'auto' : 'smooth' });
  /* 瞬时滚动：位置当场就到位了，状态直接定下来，不必等 scroll 事件。
     平滑滚动则交给 scroll / scrollend 跟着动画走（不然计数器会先跳到
     终点、再被动画中的事件拽回来，看着像抽搐）。 */
  if (instant) sync();
}

function sync(){
  var i = currentIndex();
  for (var k = 0; k < items.length; k++){
    items[k].classList.toggle('is-current', k === i);
  }
  if (nowEl) nowEl.textContent = pad2(i);
  /* 到头就禁用。用 disabled 而不是隐藏 —— 位置别跳。 */
  if (prevBtn) prevBtn.disabled = (i <= 0);
  if (nextBtn) nextBtn.disabled = (i >= LAST);
  /* 不再改 track 的 aria-label —— 那个属性改成静态的了。
     交互中反复改写它会让读屏器每一张都重报整个区域；
     位置改由 .gallery__count 的 aria-live="polite" 播报。 */
}

/* scroll 事件用 rAF 合并：平滑滚动期间会连续触发，不合并就是每帧一次布局读取。
   ⚠️ 单靠 rAF 不够 —— 后台标签页里 rAF 被暂停，而那时 ticking 会永远卡在 true，
     后续 scroll 一次也同步不了。所以再挂一个 scrollend：它不是 rAF 驱动的，
     动画收尾时会给一个确定性的回调（翻页结束才跑一次，正好用来定下最终态）。 */
var ticking = false;
function onScroll(){
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(function(){
    ticking = false;
    sync();
  });
}

track.addEventListener('scroll', onScroll, {passive:true});
if ('onscrollend' in track) track.addEventListener('scrollend', sync);
window.addEventListener('resize', onScroll);

if (prevBtn) prevBtn.addEventListener('click', function(){ goTo(currentIndex() - 1); });
if (nextBtn) nextBtn.addEventListener('click', function(){ goTo(currentIndex() + 1); });

/* 方向键。Chromium 对可聚焦滚动容器本来就支持，但显式接管可以
   保证 Home/End 也有用，并且行为在三家浏览器上一致。 */
track.addEventListener('keydown', function(e){
  var k = e.key;
  if (k === 'ArrowRight'){ e.preventDefault(); goTo(currentIndex() + 1); }
  else if (k === 'ArrowLeft'){ e.preventDefault(); goTo(currentIndex() - 1); }
  else if (k === 'Home'){ e.preventDefault(); goTo(0); }
  else if (k === 'End'){ e.preventDefault(); goTo(LAST); }
});

/* 接上之后才亮出控件、隐藏原生滚动条、允许压暗邻卡（见 layout.css） */
gallery.classList.add('is-live');
items[0].classList.add('is-current');
sync();
})();
