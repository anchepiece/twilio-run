import express from 'express';
import bodyParser from 'body-parser';
import debug from 'debug';

import { functionToRoute } from './route';
import { getFunctionsAndAssets } from './internal/runtime-paths';
import { createLogger } from './internal/request-logger';
import { setRoutes } from './internal/route-cache';

const log = debug('twilio-run:server');
const DEFAULT_PORT = process.env.PORT || 3000;

function requireUncached(module) {
  delete require.cache[require.resolve(module)];
  return require(module);
}

function loadTwilioFunction(fnPath, config) {
  if (config.live) {
    log('Uncached loading of %s', fnPath);
    return requireUncached(fnPath).handler;
  } else {
    return require(fnPath).handler;
  }
}

export async function createServer(port = DEFAULT_PORT, config) {
  config = {
    url: `http://localhost:${port}`,
    baseDir: process.cwd(),
    ...config,
  };

  log('Starting server with config: %o', config);

  const app = express();
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.json());
  app.get('/favicon.ico', (req, res) => {
    res.redirect(
      'https://www.twilio.com/marketing/bundles/marketing/img/favicons/favicon.ico'
    );
  });

  if (config.logs) {
    app.use(createLogger(config));
  }

  if (config.legacyMode) {
    process.env.TWILIO_FUNCTIONS_LEGACY_MODE = config.legacyMode;
    log('Legacy mode enabled');
    app.use('/assets/*', (req, res, next) => {
      req.path = req.path.replace('/assets/', '/');
      next();
    });
  }

  const routes = await getFunctionsAndAssets(config.baseDir);
  const routeMap = setRoutes(routes);

  app.set('port', port);
  app.all('/*', (req, res) => {
    if (!routeMap.has(req.path)) {
      res.status(404).send('Could not find request resource');
      return;
    }

    const routeInfo = routeMap.get(req.path);

    if (routeInfo.type === 'function') {
      const functionPath = routeInfo.path;
      try {
        log('Load & route to function at "%s"', functionPath);
        const twilioFunction = loadTwilioFunction(functionPath, config);
        functionToRoute(twilioFunction, config)(req, res);
      } catch (err) {
        log('Failed to retrieve function. %O', err);
        res.status(404).send(`Could not find function ${functionPath}`);
      }
    } else if (routeInfo.type === 'asset') {
      res.sendFile(routeInfo.path);
    }
  });
  return app;
}

export async function runServer(port: number | string = DEFAULT_PORT, config?) {
  const app = await createServer(port, config);
  return new Promise(resolve => {
    app.listen(port);
    resolve(app);
  });
}