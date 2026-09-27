import { Container } from "@cloudflare/containers";

export class GeraMixContainer extends Container {
  defaultPort = 3000;

  sleepAfter = "10m";
}

export default {
  async fetch(request, env) {
    const container = env.GERAMIX_CONTAINER.getByName("geramix");

    return container.fetch(request);
  }
};
