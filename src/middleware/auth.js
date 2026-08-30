'use strict';

function requireAdmin(req, res, next) {
  if (req.session?.isAdmin) {
    next();
    return;
  }
  const returnTo = encodeURIComponent(req.originalUrl);
  res.redirect(`/admin/login?next=${returnTo}`);
}

module.exports = { requireAdmin };
