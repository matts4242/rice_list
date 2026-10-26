// Ask before an irreversible form submits. The Content Security Policy
// forbids inline event handlers, so an onsubmit="return confirm(…)" attribute
// never runs; forms opt in with data-confirm="question" instead. Listening for
// submit rather than click covers keyboard submission too.
(function () {
  'use strict';

  document.addEventListener('submit', function (event) {
    var form = event.target;
    var question = form && form.dataset ? form.dataset.confirm : null;
    if (question && !window.confirm(question)) event.preventDefault();
  });
})();
