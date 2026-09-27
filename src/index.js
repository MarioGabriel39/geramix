export default {
  async fetch(request, env) {
    return new Response(
      "GeraMix Worker conectado.",
      {
        status: 200,
        headers: {
          "content-type": "text/plain; charset=UTF-8"
        }
      }
    );
  }
};

// teste de nova implantação
