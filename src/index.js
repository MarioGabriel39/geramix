import { Container } from "@cloudflare/containers";

export class MyContainer extends Container {
  defaultPort = 3000;

  sleepAfter = "10m";

  onStart() {
    console.log("GeraMix Container iniciado.");
  }

  onStop() {
    console.log("GeraMix Container parado.");
  }

  onError(error) {
    console.error("GeraMix Container:", error);
  }
}

export default {
  async fetch(request, env) {
    const container =
      env.MY_CONTAINER.getByName("geramix");

    return container.fetch(request);
  }
};
