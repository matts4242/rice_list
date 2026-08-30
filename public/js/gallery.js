// Swap the main listing photo when a thumbnail is chosen. The page is fully
// usable without this; it only upgrades the gallery.
(function () {
  'use strict';

  var main = document.getElementById('gallery-main');
  var thumbs = document.querySelectorAll('.gallery-thumb');
  if (!main || thumbs.length === 0) return;

  thumbs.forEach(function (thumb) {
    thumb.addEventListener('click', function () {
      main.src = thumb.dataset.full;
      thumbs.forEach(function (other) { other.classList.remove('is-current'); });
      thumb.classList.add('is-current');
    });
  });
})();
