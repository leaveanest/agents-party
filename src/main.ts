import { loadSettings } from "./config.js";
import { createAppServer } from "./server.js";
import { createSlackGateway } from "./slack/app.js";

const settings = loadSettings();
const slackGateway = settings.slackEnabled ? createSlackGateway(settings) : undefined;
const server = createAppServer(settings, {
  slackGateway,
});

server.listen(settings.appPort, settings.appHost, () => {
  console.log(
    `${settings.appName} listening on http://${settings.appHost}:${settings.appPort} in ${settings.appEnv} mode`,
  );
});

function shutdown(signal: NodeJS.Signals): void {
  console.log(`Received ${signal}; shutting down.`);
  server.close(async (error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
    if (slackGateway !== undefined) {
      await slackGateway.close();
    }
    process.exit();
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
