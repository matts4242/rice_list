'use strict';

const path = require('node:path');
const express = require('express');
const session = require('express-session');
const BaseSqliteStore = require('better-sqlite3-session-store')(session);
const helmet = require('helmet');

const config = require('./config');
const { getDb } = require('./db');
const { csrf } = require('./middleware/csrf');
const format = require('./lib/format');
const listingsModel = require('./lib/listings');
const flagsModel = require('./lib/flags');
const { LIMITS } = require('./lib/validate');

/**
 * The session store starts its cleanup interval without keeping a handle to
 * it, which pins the event loop open forever. Unref it so the process (and
 * the test runner) can exit normally.
 */
class SqliteStore extends BaseSqliteStore {
  startInterval() {
    this.expiryTimer = setInterval(
      this.clearExpiredSessions.bind(this),
      this.expired.intervalMs
    );
    this.expiryTimer.unref();
  }
}

/**
 * The error view is the last line of defense, so it must render even when a
 * request failed before the locals middleware ran (a rejected CSRF token, for
 * instance). Fill in only what is missing.
 */
function applyFallbackLocals(res) {
  const locals = res.locals;
  if (!locals.site) locals.site = { name: config.siteName, url: config.siteUrl };
  if (!locals.categories) locals.categories = [];
  if (!locals.flagReasons) locals.flagReasons = flagsModel.REASONS;
  if (locals.isAdmin === undefined) locals.isAdmin = false;
  if (locals.flash === undefined) locals.flash = null;
  if (!locals.csrfToken) locals.csrfToken = '';
  if (!locals.format) locals.format = format;
}

function createApp() {
  const app = express();

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.set('trust proxy', config.trustProxy ? 1 : false);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          objectSrc: ["'none'"],
        },
      },
      // Uploaded images are served same-origin; the default COEP breaks
      // nothing here but the stricter CORP default blocks nothing either.
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), {
    maxAge: config.isProduction ? '7d' : 0,
  }));
  app.use('/uploads', express.static(config.uploadDir, {
    maxAge: config.isProduction ? '30d' : 0,
    // Never let a stray file be interpreted as anything but what it is.
    setHeaders(res) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('X-Content-Type-Options', 'nosniff');
    },
  }));

  app.use(
    session({
      store: new SqliteStore({
        client: getDb(),
        expired: { clear: true, intervalMs: 15 * 60 * 1000 },
      }),
      secret: config.sessionSecret,
      resave: false,
      saveUninitialized: true,
      name: 'ricelist.sid',
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: config.isProduction,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      },
    })
  );

  // Flash messages survive exactly one redirect.
  app.use((req, res, next) => {
    res.locals.flash = req.session.flash || null;
    delete req.session.flash;
    next();
  });

  app.use((req, res, next) => {
    res.locals.site = { name: config.siteName, url: config.siteUrl };
    res.locals.categories = listingsModel.allCategories();
    res.locals.flagReasons = flagsModel.REASONS;
    res.locals.isAdmin = Boolean(req.session?.isAdmin);
    res.locals.currentPath = req.path;
    res.locals.query = req.query;
    res.locals.format = format;
    res.locals.limits = LIMITS;
    next();
  });

  app.use(csrf);

  app.use('/', require('./routes/listings'));
  app.use('/', require('./routes/messages'));
  app.use('/admin', require('./routes/admin'));

  app.get('/health', (req, res) => res.json({ ok: true }));

  app.use((req, res) => {
    applyFallbackLocals(res);
    res.status(404).render('error', {
      title: 'Page not found',
      status: 404,
      message: 'That page does not exist.',
    });
  });

  // eslint-disable-next-line no-unused-vars -- Express identifies error
  // handlers by arity, so `next` must stay in the signature.
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    applyFallbackLocals(res);
    res.status(status).render('error', {
      title: status === 429 ? 'Slow down' : 'Something went wrong',
      status,
      message:
        err.expose || status < 500
          ? err.message
          : 'Something went wrong on our end. Please try again.',
    });
  });

  return app;
}

module.exports = { createApp };
