import {
  Container,
  getContainer
} from "@cloudflare/containers";

export class GeraMixContainer extends Container {
  defaultPort = 3000;

  sleepAfter = "10m";

  enableInternet = true;

  envVars = {
    NODE_ENV: "production"
  };

  entrypoint = [
    "node",
    "server.js"
  ];
}

export default {
  async fetch(request, env) {
    const container =
      getContainer(
        env.GERAMIX_CONTAINER,
        "geramix-main"
      );

    return container.fetch(
      request
    );
  }
};
