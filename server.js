import express from "express";
import multer from "multer";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawn } from "child_process";
import archiver from "archiver";
import ffmpegPath from "ffmpeg-static";

const app = express();

const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, "public");

const BASE = path.join(os.tmpdir(), "geramix");
const UPLOADS = path.join(BASE, "uploads");
const JOBS = path.join(BASE, "jobs");

/* =========================================================
   SUPABASE
========================================================= */

const SUPABASE_URL =
  process.env.SUPABASE_URL;

const SUPABASE_ANON_KEY =
  process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "SUPABASE_URL e SUPABASE_ANON_KEY precisam estar configuradas."
  );
}

/* =========================================================
   DIRETÓRIOS
========================================================= */

await Promise.all([
  fsp.mkdir(UPLOADS, { recursive: true }),
  fsp.mkdir(JOBS, { recursive: true })
]);

/* =========================================================
   ARQUIVOS PÚBLICOS
========================================================= */

app.use(express.static(PUBLIC));

/*
  Usado somente pelo novo fluxo do Vercel.
  O limite é pequeno porque agora o Vercel recebe
  apenas JSON com caminhos dos arquivos no Storage.
*/
app.use(
  express.json({
    limit: "1mb"
  })
);

/* =========================================================
   CONFIGURAÇÃO DO FRONT-END
========================================================= */

app.get("/api/config", (_, res) => {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  res.json({
    supabaseUrl:
      SUPABASE_URL,

    supabaseAnonKey:
      SUPABASE_ANON_KEY,

    /*
      No Vercel:
      o navegador envia os vídeos diretamente
      para o Supabase Storage.

      No Render:
      continua usando o upload multipart antigo.
    */
    uploadMode:
      process.env.VERCEL
        ? "storage"
        : "multipart"
  });
});

/* =========================================================
   AUTENTICAÇÃO
========================================================= */

async function requireAuth(req, res, next) {
  try {
    const authorization =
      String(
        req.headers.authorization || ""
      ).trim();

    let token = "";

    if (
      authorization
        .toLowerCase()
        .startsWith("bearer ")
    ) {
      token =
        authorization
          .slice(7)
          .trim();
    }

    if (!token) {
      token =
        String(
          req.query.token || ""
        ).trim();
    }

    if (!token) {
      console.error(
        "GeraMix: nenhuma sessão foi enviada."
      );

      return res.status(401).json({
        error:
          "Sessão não enviada."
      });
    }

    if (token.startsWith("sb_")) {
      console.error(
        "GeraMix: Publishable Key recebida no lugar do token do usuário."
      );

      return res.status(401).json({
        error:
          "Token de usuário inválido."
      });
    }

    const response =
      await fetch(
        `${SUPABASE_URL}/auth/v1/user`,
        {
          method: "GET",

          headers: {
            Authorization:
              `Bearer ${token}`,

            apikey:
              SUPABASE_ANON_KEY
          }
        }
      );

    if (!response.ok) {
      let details = "";

      try {
        const data =
          await response.json();

        details =
          data?.msg ||
          data?.message ||
          data?.error_description ||
          data?.error ||
          "";
      } catch {
        details = "";
      }

      console.error(
        "GeraMix: Supabase recusou o token.",
        response.status,
        details
      );

      return res.status(401).json({
        error:
          "Sessão inválida ou expirada."
      });
    }

    const user =
      await response.json();

    if (!user || !user.id) {
      console.error(
        "GeraMix: Supabase respondeu sem usuário."
      );

      return res.status(401).json({
        error:
          "Sessão inválida ou expirada."
      });
    }

    req.user =
      user;

    req.accessToken =
      token;

    next();

  } catch (error) {
    console.error(
      "Erro ao validar sessão:",
      error
    );

    return res.status(401).json({
      error:
        "Não foi possível validar sua sessão."
    });
  }
}

/* =========================================================
   RESERVA DE COTA
========================================================= */

async function reserveVideoQuota(
  userId,
  accessToken,
  amount
) {

  const response =
    await fetch(
      SUPABASE_URL +
        "/rest/v1/rpc/reserve_video_quota",
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            "Bearer " +
            accessToken,

          apikey:
            SUPABASE_ANON_KEY
        },

        body:
          JSON.stringify({
            p_user_id:
              userId,

            p_amount:
              amount
          })
      }
    );

  if (!response.ok) {

    let details = "";

    try {
      const data =
        await response.json();

      details =
        data?.message ||
        data?.msg ||
        data?.error_description ||
        data?.error ||
        "";
    } catch {
      details = "";
    }

    console.error(
      "GeraMix: erro ao reservar cota.",
      response.status,
      details
    );

    throw new Error(
      "Não foi possível verificar sua cota mensal."
    );
  }

  const data =
    await response.json();

  const result =
    Array.isArray(data)
      ? data[0]
      : data;

  if (!result) {
    throw new Error(
      "O servidor não recebeu a resposta da cota."
    );
  }

  return {
    allowed:
      Boolean(result.allowed),

    videosUsed:
      Number(
        result.videos_used || 0
      ),

    monthlyLimit:
      Number(
        result.monthly_limit || 0
      ),

    message:
      result.message ||
      ""
  };
}

/* =========================================================
   DEVOLVE COTA QUANDO O PROCESSAMENTO FALHA
========================================================= */

async function releaseVideoQuota(
  userId,
  accessToken,
  amount
) {

  if (!amount || amount <= 0) {
    return;
  }

  try {

    const response =
      await fetch(
        SUPABASE_URL +
          "/rest/v1/rpc/release_video_quota",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            Authorization:
              "Bearer " +
              accessToken,

            apikey:
              SUPABASE_ANON_KEY
          },

          body:
            JSON.stringify({
              p_user_id:
                userId,

              p_amount:
                amount
            })
        }
      );

    if (!response.ok) {

      let details = "";

      try {
        const data =
          await response.json();

        details =
          data?.message ||
          data?.msg ||
          data?.error_description ||
          data?.error ||
          "";
      } catch {
        details = "";
      }

      console.error(
        "GeraMix: não foi possível devolver a cota.",
        response.status,
        details
      );

      return;
    }

    console.log(
      `GeraMix: ${amount} vídeo(s) devolvido(s) para a cota mensal.`
    );

  } catch (error) {

    console.error(
      "GeraMix: erro ao devolver cota:",
      error
    );
  }
}

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    service: "geramix",
    ffmpeg: Boolean(ffmpegPath)
  });
});

/* =========================================================
   CONFIGURAÇÕES
========================================================= */

const FFMPEG_CONCURRENCY = 1;

const MAX_COMBINATIONS = 150;

const DOWNLOADS_BUCKET =
  "geramix-downloads";

/* =========================================================
   FFMPEG
========================================================= */

function runFFmpeg(args, cwd) {
  return new Promise(
    (resolve, reject) => {

      const p =
        spawn(
          ffmpegPath,
          [
            "-hide_banner",
            "-loglevel",
            "error",

            "-threads",
            "1",

            ...args
          ],
          {
            cwd
          }
        );

      let err = "";

      p.stderr.on(
        "data",
        data => {
          err += data.toString();

          if (err.length > 10000) {
            err =
              err.slice(-10000);
          }
        }
      );

      p.on(
        "error",
        reject
      );

      p.on(
        "close",
        code => {

          if (code === 0) {
            resolve();
          } else {
            reject(
              new Error(
                err.trim() ||
                `FFmpeg saiu com código ${code}`
              )
            );
          }

        }
      );

    }
  );
}

/* =========================================================
   VERIFICA ÁUDIO
========================================================= */

async function hasAudio(input, cwd) {
  try {

    await runFFmpeg(
      [
        "-i",
        input,

        "-map",
        "0:a:0",

        "-frames:a",
        "0",

        "-f",
        "null",

        "-"
      ],
      cwd
    );

    return true;

  } catch {
    return false;
  }
}

/* =========================================================
   NORMALIZA UM VÍDEO
========================================================= */

async function normalizeVideo(
  input,
  output,
  cwd
) {

  const audio =
    await hasAudio(
      input,
      cwd
    );

  const args = [
    "-i",
    input
  ];

  if (!audio) {
    args.push(
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo"
    );
  }

  args.push(
    "-map",
    "0:v:0",

    "-map",
    audio
      ? "0:a:0"
      : "1:a:0",

    "-vf",
    "scale=720:1280:force_original_aspect_ratio=decrease," +
      "pad=720:1280:(ow-iw)/2:(oh-ih)/2," +
      "setsar=1," +
      "fps=30," +
      "format=yuv420p",

    "-c:v",
    "libx264",

    "-preset",
    "ultrafast",

    "-crf",
    "28",

    "-pix_fmt",
    "yuv420p",

    "-r",
    "30",

    "-c:a",
    "aac",

    "-ar",
    "48000",

    "-ac",
    "2",

    "-b:a",
    "96k",

    "-shortest",

    "-y",
    output
  );

  await runFFmpeg(
    args,
    cwd
  );
}

/* =========================================================
   JUNTA 3 VÍDEOS
========================================================= */

async function concatNormalized(
  files,
  output,
  cwd
) {

  const listFile =
    path.join(
      cwd,
      `concat-${crypto.randomUUID()}.txt`
    );

  const content =
    files
      .map(
        file =>
          `file '${path.basename(file).replace(/'/g, "'\\''")}'`
      )
      .join("\n");

  await fsp.writeFile(
    listFile,
    content,
    "utf8"
  );

  try {

    await runFFmpeg(
      [
        "-f",
        "concat",

        "-safe",
        "0",

        "-i",
        listFile,

        "-c",
        "copy",

        "-y",
        output
      ],
      cwd
    );

  } finally {

    await fsp.rm(
      listFile,
      {
        force: true
      }
    );

  }
}

/* =========================================================
   NOME SEGURO
========================================================= */

function safeName(name) {
  return String(
    name || "video"
  )
    .replace(
      /[^a-zA-Z0-9.*-]/g,
      "*"
    )
    .slice(-100);
}

/* =========================================================
   ORIGINALIDADE
========================================================= */

function calculateOriginality(
  current,
  previous
) {

  if (!previous) {
    return 100;
  }

  let different = 0;

  if (
    current.hook.path !==
    previous.hook.path
  ) {
    different++;
  }

  if (
    current.body.path !==
    previous.body.path
  ) {
    different++;
  }

  if (
    current.cta.path !==
    previous.cta.path
  ) {
    different++;
  }

  return 70 + different * 10;
}

/* =========================================================
   CAMINHO DO STORAGE
========================================================= */

function getStoragePath(
  userId,
  jobId,
  fileName
) {

  return [
    String(userId),
    String(jobId),
    String(fileName)
  ].join("/");
}

/* =========================================================
   CAMINHO DE INPUT TEMPORÁRIO NO STORAGE
========================================================= */

function getInputStoragePath(
  userId,
  jobId,
  category,
  index,
  originalName
) {

  const ext =
    path.extname(
      String(
        originalName || ""
      )
    )
    .toLowerCase()
    .replace(
      /[^a-z0-9.]/g,
      ""
    );

  const safeExt =
    ext &&
    ext.length <= 10
      ? ext
      : ".mp4";

  return [
    String(userId),
    "inputs",
    String(jobId),
    String(category),
    `${String(index + 1).padStart(3, "0")}-${crypto.randomUUID()}${safeExt}`
  ].join("/");
}

/* =========================================================
   VALIDA CAMINHO DE INPUT
========================================================= */

function isValidInputStoragePath(
  userId,
  storagePath,
  jobId,
  category
) {

  if (
    typeof storagePath !==
    "string"
  ) {
    return false;
  }

  if (
    storagePath.includes("..") ||
    storagePath.startsWith("/")
  ) {
    return false;
  }

  const prefix =
    `${userId}/inputs/${jobId}/${category}/`;

  return storagePath.startsWith(
    prefix
  );
}

/* =========================================================
   DOWNLOAD DE INPUT DO SUPABASE STORAGE
========================================================= */

async function downloadStorageFile(
  storagePath,
  outputFile,
  accessToken
) {

  const encodedPath =
    storagePath
      .split("/")
      .map(
        part =>
          encodeURIComponent(part)
      )
      .join("/");

  const response =
    await fetch(
      `${SUPABASE_URL}/storage/v1/object/authenticated/${DOWNLOADS_BUCKET}/${encodedPath}`,
      {
        method: "GET",

        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          apikey:
            SUPABASE_ANON_KEY
        }
      }
    );

  if (!response.ok) {

    let details = "";

    try {
      details =
        await response.text();
    } catch {
      details = "";
    }

    throw new Error(
      "Não foi possível baixar o vídeo de origem do Storage." +
      (details
        ? ` ${details}`
        : "")
    );
  }

  if (!response.body) {
    throw new Error(
      "O Storage não retornou o conteúdo do vídeo."
    );
  }

  const fileHandle =
    await fsp.open(
      outputFile,
      "w"
    );

  try {

    const writable =
      fileHandle.createWriteStream();

    await response.body.pipeTo(
      new WritableStream({
        write(chunk) {
          return new Promise(
            (resolve, reject) => {
              writable.write(
                Buffer.from(chunk),
                error => {
                  if (error) {
                    reject(error);
                  } else {
                    resolve();
                  }
                }
              );
            }
          );
        },

        close() {
          return new Promise(
            (resolve, reject) => {
              writable.end(
                error => {
                  if (error) {
                    reject(error);
                  } else {
                    resolve();
                  }
                }
              );
            }
          );
        },

        abort(error) {
          writable.destroy(error);
        }
      })
    );

  } finally {

    await fileHandle.close();

  }
}

/* =========================================================
   EXCLUI INPUT DO STORAGE
========================================================= */

async function deleteInputFromStorage(
  storagePath,
  accessToken
) {

  const encodedPath =
    storagePath
      .split("/")
      .map(
        part =>
          encodeURIComponent(part)
      )
      .join("/");

  try {

    const response =
      await fetch(
        `${SUPABASE_URL}/storage/v1/object/${DOWNLOADS_BUCKET}/${encodedPath}`,
        {
          method: "DELETE",

          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            apikey:
              SUPABASE_ANON_KEY
          }
        }
      );

    if (!response.ok) {

      let details = "";

      try {
        details =
          await response.text();
      } catch {
        details = "";
      }

      console.error(
        "GeraMix: erro ao excluir input do Storage.",
        response.status,
        details
      );

      return false;
    }

    return true;

  } catch (error) {

    console.error(
      "GeraMix: erro excluindo input do Storage:",
      error
    );

    return false;
  }
}

/* =========================================================
   UPLOAD DE VÍDEO FINAL PARA STORAGE
========================================================= */

async function uploadVideoToStorage(
  localFile,
  storagePath,
  accessToken
) {

  const encodedPath =
    storagePath
      .split("/")
      .map(
        part =>
          encodeURIComponent(part)
      )
      .join("/");

  const stat =
    await fsp.stat(
      localFile
    );

  const stream =
    fs.createReadStream(
      localFile
    );

  try {

    const response =
      await fetch(
        `${SUPABASE_URL}/storage/v1/object/${DOWNLOADS_BUCKET}/${encodedPath}`,
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            apikey:
              SUPABASE_ANON_KEY,

            "Content-Type":
              "video/mp4",

            "Content-Length":
              String(stat.size),

            "x-upsert":
              "false"
          },

          body:
            stream,

          duplex:
            "half"
        }
      );

    if (!response.ok) {

      let details = "";

      try {
        const data =
          await response.json();

        details =
          data?.message ||
          data?.error ||
          data?.statusCode ||
          "";
      } catch {
        try {
          details =
            await response.text();
        } catch {
          details = "";
        }
      }

      throw new Error(
        "Erro ao enviar vídeo para o Storage." +
        (details
          ? ` ${details}`
          : "")
      );
    }

    return true;

  } finally {

    stream.destroy();

  }
}

/* =========================================================
   EXCLUI VÍDEO DO STORAGE
========================================================= */

async function deleteVideoFromStorage(
  storagePath,
  accessToken
) {

  const encodedPath =
    storagePath
      .split("/")
      .map(
        part =>
          encodeURIComponent(part)
      )
      .join("/");

  try {

    const response =
      await fetch(
        `${SUPABASE_URL}/storage/v1/object/${DOWNLOADS_BUCKET}/${encodedPath}`,
        {
          method: "DELETE",

          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            apikey:
              SUPABASE_ANON_KEY
          }
        }
      );

    if (!response.ok) {

      let details = "";

      try {
        details =
          await response.text();
      } catch {
        details = "";
      }

      console.error(
        "GeraMix: erro ao excluir vídeo do Storage.",
        response.status,
        details
      );

      return false;
    }

    return true;

  } catch (error) {

    console.error(
      "GeraMix: erro excluindo vídeo do Storage:",
      error
    );

    return false;
  }
}

/* =========================================================
   REGISTRA VÍDEO NA TABELA DOWNLOADS
========================================================= */

async function registerDownload(
  {
    userId,
    jobId,
    fileName,
    storagePath,
    originality
  },
  accessToken
) {

  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/downloads`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Authorization:
            `Bearer ${accessToken}`,

          apikey:
            SUPABASE_ANON_KEY,

          Prefer:
            "return=minimal"
        },

        body:
          JSON.stringify({
            user_id:
              userId,

            job_id:
              jobId,

            file_name:
              fileName,

            storage_path:
              storagePath,

            originality:
              originality
          })
      }
    );

  if (!response.ok) {

    let details = "";

    try {
      const data =
        await response.json();

      details =
        data?.message ||
        data?.msg ||
        data?.error ||
        data?.details ||
        "";
    } catch {
      try {
        details =
          await response.text();
      } catch {
        details = "";
      }
    }

    throw new Error(
      "Erro ao registrar vídeo na Central de Downloads." +
      (details
        ? ` ${details}`
        : "")
    );
  }

  return true;
}

/* =========================================================
   EXCLUI REGISTROS DE DOWNLOAD
========================================================= */

async function deleteDownloadRecords(
  userId,
  jobId,
  accessToken
) {

  try {

    const url =
      `${SUPABASE_URL}/rest/v1/downloads` +
      `?user_id=eq.${encodeURIComponent(userId)}` +
      `&job_id=eq.${encodeURIComponent(jobId)}`;

    const response =
      await fetch(
        url,
        {
          method: "DELETE",

          headers: {
            Authorization:
              `Bearer ${accessToken}`,

            apikey:
              SUPABASE_ANON_KEY,

            Prefer:
              "return=minimal"
          }
        }
      );

    if (!response.ok) {

      let details = "";

      try {
        details =
          await response.text();
      } catch {
        details = "";
      }

      console.error(
        "GeraMix: erro ao limpar registros de downloads.",
        response.status,
        details
      );

      return false;
    }

    return true;

  } catch (error) {

    console.error(
      "GeraMix: erro limpando registros de downloads:",
      error
    );

    return false;
  }
}

/* =========================================================
   LIMPA VÍDEOS ARMAZENADOS QUANDO UM JOB FALHA
========================================================= */

async function cleanupStoredDownloads(
  job,
  accessToken
) {

  if (
    !job ||
    !Array.isArray(job.downloads)
  ) {
    return;
  }

  for (
    const download
    of job.downloads
  ) {

    if (
      download?.storagePath
    ) {

      await deleteVideoFromStorage(
        download.storagePath,
        accessToken
      );

    }
  }

  await deleteDownloadRecords(
    job.userId,
    job.id,
    accessToken
  );

  job.downloads = [];
}

/* =========================================================
   MULTER
========================================================= */

const upload =
  multer({
    dest: UPLOADS,

    limits: {
      files: 30,

      fileSize:
        200 * 1024 * 1024
    }
  });

/* =========================================================
   JOBS
========================================================= */

const jobs =
  new Map();

/* =========================================================
   OBTÉM VÍDEOS NORMALIZADOS
========================================================= */

function getCombinationFiles(
  job,
  file
) {

  const dir =
    path.join(
      JOBS,
      job.id
    );

  const hook =
    path.join(
      dir,
      `hook-${String(file.hookIndex).padStart(3, "0")}.mp4`
    );

  const body =
    path.join(
      dir,
      `body-${String(file.bodyIndex).padStart(3, "0")}.mp4`
    );

  const cta =
    path.join(
      dir,
      `cta-${String(file.ctaIndex).padStart(3, "0")}.mp4`
    );

  return [
    hook,
    body,
    cta
  ];
}

/* =========================================================
   CRIA UM VÍDEO TEMPORÁRIO
========================================================= */

async function createVideoForJob(
  job,
  file
) {

  const dir =
    path.join(
      JOBS,
      job.id
    );

  const tempName =
    `temp-${crypto.randomUUID()}.mp4`;

  const output =
    path.join(
      dir,
      tempName
    );

  const sources =
    getCombinationFiles(
      job,
      file
    );

  try {

    await concatNormalized(
      sources,
      output,
      dir
    );

    return output;

  } catch (error) {

    await fsp.rm(
      output,
      {
        force: true
      }
    );

    throw error;
  }
}

/* =========================================================
   PROCESSAMENTO COMUM
========================================================= */

async function processJob(
  {
    job,
    hooks,
    bodies,
    ctas,
    dir,
    accessToken
  }
) {

  const normalizedHooks = [];
  const normalizedBodies = [];
  const normalizedCtas = [];

  const inputStorageFiles =
    Array.isArray(
      job.inputStorageFiles
    )
      ? job.inputStorageFiles
      : [];

  try {

    job.current =
      "Preparando ganchos…";

    for (
      let i = 0;
      i < hooks.length;
      i++
    ) {

      const file =
        hooks[i];

      const output =
        path.join(
          dir,
          `hook-${String(i + 1).padStart(3, "0")}.mp4`
        );

      await normalizeVideo(
        file.path,
        output,
        dir
      );

      normalizedHooks.push({
        source:
          file,

        path:
          output
      });

      await fsp.rm(
        file.path,
        {
          force: true
        }
      );
    }

    job.current =
      "Preparando corpos…";

    for (
      let i = 0;
      i < bodies.length;
      i++
    ) {

      const file =
        bodies[i];

      const output =
        path.join(
          dir,
          `body-${String(i + 1).padStart(3, "0")}.mp4`
        );

      await normalizeVideo(
        file.path,
        output,
        dir
      );

      normalizedBodies.push({
        source:
          file,

        path:
          output
      });

      await fsp.rm(
        file.path,
        {
          force: true
        }
      );
    }

    job.current =
      "Preparando CTAs…";

    for (
      let i = 0;
      i < ctas.length;
      i++
    ) {

      const file =
        ctas[i];

      const output =
        path.join(
          dir,
          `cta-${String(i + 1).padStart(3, "0")}.mp4`
        );

      await normalizeVideo(
        file.path,
        output,
        dir
      );

      normalizedCtas.push({
        source:
          file,

        path:
          output
      });

      await fsp.rm(
        file.path,
        {
          force: true
        }
      );
    }

    if (
      inputStorageFiles.length
    ) {

      for (
        const storagePath
        of inputStorageFiles
      ) {

        await deleteInputFromStorage(
          storagePath,
          accessToken
        );

      }

      job.inputStorageFiles =
        [];
    }

    job.current =
      "Preparando combinações…";

    let index = 0;

    for (
      let hookIndex = 0;
      hookIndex <
      normalizedHooks.length;
      hookIndex++
    ) {

      for (
        let bodyIndex = 0;
        bodyIndex <
        normalizedBodies.length;
        bodyIndex++
      ) {

        for (
          let ctaIndex = 0;
          ctaIndex <
          normalizedCtas.length;
          ctaIndex++
        ) {

          index++;

          const hook =
            normalizedHooks[
              hookIndex
            ];

          const body =
            normalizedBodies[
              bodyIndex
            ];

          const cta =
            normalizedCtas[
              ctaIndex
            ];

          job.current =
            `Preparando vídeos: ${index}/${job.total}`;

          const currentCombination = {
            hook: {
              path:
                hook.source.path
            },

            body: {
              path:
                body.source.path
            },

            cta: {
              path:
                cta.source.path
            }
          };

          const previousIndex =
            index - 2;

          const previousCombination =
            previousIndex >= 0
              ? {
                  hook: {
                    path:
                      normalizedHooks[
                        Math.floor(
                          previousIndex /
                          (
                            normalizedBodies.length *
                            normalizedCtas.length
                          )
                        )
                      ]?.source.path
                  },

                  body: {
                    path:
                      normalizedBodies[
                        Math.floor(
                          (
                            previousIndex /
                            normalizedCtas.length
                          ) %
                          normalizedBodies.length
                        )
                      ]?.source.path
                  },

                  cta: {
                    path:
                      normalizedCtas[
                        previousIndex %
                        normalizedCtas.length
                      ]?.source.path
                  }
                }
              : null;

          const originality =
            calculateOriginality(
              currentCombination,
              previousCombination
            );

          job.files.push({

            name:
              `video-${String(index).padStart(3, "0")}.mp4`,

            hook:
              safeName(
                hook.source.originalname
              ),

            body:
              safeName(
                body.source.originalname
              ),

            cta:
              safeName(
                cta.source.originalname
              ),

            hookIndex:
              hookIndex + 1,

            bodyIndex:
              bodyIndex + 1,

            ctaIndex:
              ctaIndex + 1,

            index,

            originality
          });

        }
      }
    }

    job.files.sort(
      (a, b) =>
        a.index - b.index
    );

    job.done = 0;

    for (
      let i = 0;
      i < job.files.length;
      i++
    ) {

      const file =
        job.files[i];

      const position =
        i + 1;

      job.current =
        `Gerando vídeo ${position}/${job.total}…`;

      const tempVideo =
        await createVideoForJob(
          job,
          file
        );

      const storagePath =
        getStoragePath(
          job.userId,
          job.id,
          file.name
        );

      try {

        job.current =
          `Enviando vídeo ${position}/${job.total}…`;

        await uploadVideoToStorage(
          tempVideo,
          storagePath,
          accessToken
        );

        await registerDownload(
          {
            userId:
              job.userId,

            jobId:
              job.id,

            fileName:
              file.name,

            storagePath,

            originality:
              file.originality
          },
          accessToken
        );

        job.downloads.push({
          fileName:
            file.name,

          storagePath,

          originality:
            file.originality
        });

        job.done =
          position;

        job.current =
          `Vídeo ${position}/${job.total} concluído.`;

      } catch (error) {

        await deleteVideoFromStorage(
          storagePath,
          accessToken
        );

        throw error;

      } finally {

        await fsp.rm(
          tempVideo,
          {
            force: true
          }
        );

      }
    }

    job.current =
      "Concluído";

    job.status =
      "done";

    job.zip =
      `/api/jobs/${job.id}/zip`;

    console.log(
      `GeraMix: job ${job.id} concluído com ${job.total} vídeo(s) armazenado(s).`
    );

  } catch (error) {

    console.error(
      "Erro no processamento:",
      error
    );

    await cleanupStoredDownloads(
      job,
      accessToken
    );

    await releaseVideoQuota(
      job.userId,
      accessToken,
      job.total
    );

    job.status =
      "error";

    job.error =
      error?.message ||
      "Erro desconhecido";

    job.current =
      "Falhou";

    for (
      const file
      of [
        ...hooks,
        ...bodies,
        ...ctas
      ]
    ) {

      await fsp.rm(
        file.path,
        {
          force: true
        }
      ).catch(() => {});

    }

    if (
      Array.isArray(
        job.inputStorageFiles
      )
    ) {

      for (
        const storagePath
        of job.inputStorageFiles
      ) {

        await deleteInputFromStorage(
          storagePath,
          accessToken
        );

      }

      job.inputStorageFiles =
        [];
    }
  }
}

/* =========================================================
   NOVO FLUXO PARA VERCEL
========================================================= */

app.post(
  "/api/jobs/storage",

  requireAuth,

  async (req, res) => {

    try {

      const hooks =
        Array.isArray(req.body?.hooks)
          ? req.body.hooks
          : [];

      const bodies =
        Array.isArray(req.body?.bodies)
          ? req.body.bodies
          : [];

      const ctas =
        Array.isArray(req.body?.ctas)
          ? req.body.ctas
          : [];

      const clientJobId =
        String(
          req.body?.id || ""
        ).trim();

      if (
        !clientJobId ||
        !/^[0-9a-f-]{36}$/i.test(
          clientJobId
        )
      ) {

        return res.status(400).json({
          error:
            "Identificador do processamento inválido."
        });
      }

      if (
        !hooks.length ||
        !bodies.length ||
        !ctas.length
      ) {

        return res.status(400).json({
          error:
            "Envie pelo menos 1 vídeo em cada categoria."
        });
      }

      if (
        hooks.length > 5 ||
        bodies.length > 5 ||
        ctas.length > 6
      ) {

        return res.status(400).json({
          error:
            "Quantidade máxima: 5 ganchos, 5 corpos e 6 CTAs."
        });
      }

      const total =
        hooks.length *
        bodies.length *
        ctas.length;

      if (
        total >
        MAX_COMBINATIONS
      ) {

        return res.status(400).json({
          error:
            `Limite de ${MAX_COMBINATIONS} combinações por lote.`
        });
      }

      const allItems = [
        ...hooks.map(
          item => ({
            ...item,
            category:
              "hooks"
          })
        ),

        ...bodies.map(
          item => ({
            ...item,
            category:
              "bodies"
          })
        ),

        ...ctas.map(
          item => ({
            ...item,
            category:
              "ctas"
          })
        )
      ];

      for (
        const item
        of allItems
      ) {

        if (
          !item ||
          typeof item.path !==
            "string"
        ) {

          return res.status(400).json({
            error:
              "Um dos vídeos enviados possui caminho inválido."
          });
        }

        if (
          !isValidInputStoragePath(
            req.user.id,
            item.path,
            clientJobId,
            item.category
          )
        ) {

          return res.status(403).json({
            error:
              "Um dos arquivos enviados não pertence à sua sessão."
          });
        }
      }

      let quota;

      try {

        quota =
          await reserveVideoQuota(
            req.user.id,
            req.accessToken,
            total
          );

      } catch (error) {

        return res.status(503).json({
          error:
            error?.message ||
            "Não foi possível verificar sua cota mensal."
        });
      }

      if (!quota.allowed) {

        return res.status(403).json({

          error:
            quota.message ||
            "Limite mensal de vídeos atingido.",

          videosUsed:
            quota.videosUsed,

          monthlyLimit:
            quota.monthlyLimit
        });
      }

      const id =
        clientJobId;

      const dir =
        path.join(
          JOBS,
          id
        );

      await fsp.mkdir(
        dir,
        {
          recursive: true
        }
      );

      const job = {
        id,

        userId:
          req.user.id,

        status:
          "processing",

        total,

        done:
          0,

        current:
          "Baixando vídeos enviados…",

        files: [],

        downloads: [],

        error:
          null,

        mode:
          "storage-direto",

        videosUsed:
          quota.videosUsed,

        monthlyLimit:
          quota.monthlyLimit,

        inputStorageFiles:
          allItems.map(
            item =>
              item.path
          )
      };

      jobs.set(
        id,
        job
      );

      res.json({
        id,

        total,

        videosUsed:
          quota.videosUsed,

        monthlyLimit:
          quota.monthlyLimit
      });

      const localHooks = [];
      const localBodies = [];
      const localCtas = [];

      try {

        for (
          let i = 0;
          i < hooks.length;
          i++
        ) {

          const item =
            hooks[i];

          const originalname =
            String(
              item.originalname ||
              `hook-${i + 1}.mp4`
            );

          const localPath =
            path.join(
              dir,
              `input-hook-${String(i + 1).padStart(3, "0")}-${crypto.randomUUID()}${path.extname(originalname) || ".mp4"}`
            );

          job.current =
            `Baixando gancho ${i + 1}/${hooks.length}…`;

          await downloadStorageFile(
            item.path,
            localPath,
            req.accessToken
          );

          localHooks.push({
            path:
              localPath,

            originalname
          });
        }

        for (
          let i = 0;
          i < bodies.length;
          i++
        ) {

          const item =
            bodies[i];

          const originalname =
            String(
              item.originalname ||
              `body-${i + 1}.mp4`
            );

          const localPath =
            path.join(
              dir,
              `input-body-${String(i + 1).padStart(3, "0")}-${crypto.randomUUID()}${path.extname(originalname) || ".mp4"}`
            );

          job.current =
            `Baixando corpo ${i + 1}/${bodies.length}…`;

          await downloadStorageFile(
            item.path,
            localPath,
            req.accessToken
          );

          localBodies.push({
            path:
              localPath,

            originalname
          });
        }

        for (
          let i = 0;
          i < ctas.length;
          i++
        ) {

          const item =
            ctas[i];

          const originalname =
            String(
              item.originalname ||
              `cta-${i + 1}.mp4`
            );

          const localPath =
            path.join(
              dir,
              `input-cta-${String(i + 1).padStart(3, "0")}-${crypto.randomUUID()}${path.extname(originalname) || ".mp4"}`
            );

          job.current =
            `Baixando CTA ${i + 1}/${ctas.length}…`;

          await downloadStorageFile(
            item.path,
            localPath,
            req.accessToken
          );

          localCtas.push({
            path:
              localPath,

            originalname
          });
        }

        await processJob({
          job,

          hooks:
            localHooks,

          bodies:
            localBodies,

          ctas:
            localCtas,

          dir,

          accessToken:
            req.accessToken
        });

      } catch (error) {

        console.error(
          "GeraMix: erro baixando inputs do Storage:",
          error
        );

        if (
          job.status ===
          "processing"
        ) {

          await cleanupStoredDownloads(
            job,
            req.accessToken
          );

          await releaseVideoQuota(
            req.user.id,
            req.accessToken,
            total
          );

          job.status =
            "error";

          job.error =
            error?.message ||
            "Erro ao baixar os vídeos enviados.";

          job.current =
            "Falhou";

        }

        for (
          const file
          of [
            ...localHooks,
            ...localBodies,
            ...localCtas
          ]
        ) {

          await fsp.rm(
            file.path,
            {
              force: true
            }
          ).catch(() => {});

        }

        for (
          const storagePath
          of job.inputStorageFiles || []
        ) {

          await deleteInputFromStorage(
            storagePath,
            req.accessToken
          );

        }

        job.inputStorageFiles =
          [];
      }

    } catch (error) {

      console.error(
        "GeraMix: erro no endpoint storage:",
        error
      );

      if (!res.headersSent) {

        return res.status(500).json({
          error:
            error?.message ||
            "Erro interno ao iniciar processamento."
        });
      }

    }

  }
);

/* =========================================================
   FLUXO ANTIGO / RENDER
========================================================= */

app.post(
  "/api/jobs",

  requireAuth,

  upload.fields([
    {
      name: "hooks",
      maxCount: 5
    },

    {
      name: "bodies",
      maxCount: 5
    },

    {
      name: "ctas",
      maxCount: 6
    }
  ]),

  async (req, res) => {

    const hooks =
      req.files?.hooks || [];

    const bodies =
      req.files?.bodies || [];

    const ctas =
      req.files?.ctas || [];

    if (
      !hooks.length ||
      !bodies.length ||
      !ctas.length
    ) {

      return res.status(400).json({
        error:
          "Envie pelo menos 1 vídeo em cada categoria."
      });
    }

    const total =
      hooks.length *
      bodies.length *
      ctas.length;

    if (
      total >
      MAX_COMBINATIONS
    ) {

      await Promise.all(
        [
          ...hooks,
          ...bodies,
          ...ctas
        ].map(
          file =>
            fsp.rm(
              file.path,
              {
                force: true
              }
            )
        )
      );

      return res.status(400).json({
        error:
          `Limite de ${MAX_COMBINATIONS} combinações por lote.`
      });
    }

    let quota;

    try {

      quota =
        await reserveVideoQuota(
          req.user.id,
          req.accessToken,
          total
        );

    } catch (error) {

      await Promise.all(
        [
          ...hooks,
          ...bodies,
          ...ctas
        ].map(
          file =>
            fsp.rm(
              file.path,
              {
                force: true
              }
            )
        )
      );

      return res.status(503).json({
        error:
          error?.message ||
          "Não foi possível verificar sua cota mensal."
      });
    }

    if (!quota.allowed) {

      await Promise.all(
        [
          ...hooks,
          ...bodies,
          ...ctas
        ].map(
          file =>
            fsp.rm(
              file.path,
              {
                force: true
              }
            )
        )
      );

      return res.status(403).json({

        error:
          quota.message ||
          "Limite mensal de vídeos atingido.",

        videosUsed:
          quota.videosUsed,

        monthlyLimit:
          quota.monthlyLimit
      });
    }

    const id =
      crypto.randomUUID();

    const dir =
      path.join(
        JOBS,
        id
      );

    await fsp.mkdir(
      dir,
      {
        recursive: true
      }
    );

    const job = {
      id,

      userId:
        req.user.id,

      status:
        "processing",

      total,

      done:
        0,

      current:
        "Iniciando…",

      files: [],

      downloads: [],

      error:
        null,

      mode:
        "montagem-sob-demanda",

      videosUsed:
        quota.videosUsed,

      monthlyLimit:
        quota.monthlyLimit,

      inputStorageFiles:
        []
    };

    jobs.set(
      id,
      job
    );

    res.json({
      id,

      total,

      videosUsed:
        quota.videosUsed,

      monthlyLimit:
        quota.monthlyLimit
    });

    processJob({
      job,

      hooks,

      bodies,

      ctas,

      dir,

      accessToken:
        req.accessToken
    });

  }
);

/* =========================================================
   CONSULTA JOB
========================================================= */

app.get(
  "/api/jobs/:id",

  requireAuth,

  (req, res) => {

    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {

      return res.status(404).json({
        error:
          "Processamento não encontrado."
      });
    }

    if (
      job.userId !==
      req.user.id
    ) {

      return res.status(404).json({
        error:
          "Processamento não encontrado."
      });
    }

    res.json(job);
  }
);

/* =========================================================
   DOWNLOAD ZIP
========================================================= */

app.get(
  "/api/jobs/:id/zip",

  requireAuth,

  async (req, res) => {

    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {

      return res
        .status(404)
        .send(
          "Processamento não encontrado."
        );
    }

    if (
      job.userId !==
      req.user.id
    ) {

      return res
        .status(404)
        .send(
          "Processamento não encontrado."
        );
    }

    if (
      job.status !==
      "done"
    ) {

      return res
        .status(400)
        .send(
          "O processamento ainda não terminou."
        );
    }

    res.statusCode = 200;

    res.setHeader(
      "Content-Type",
      "application/zip"
    );

    res.setHeader(
      "Content-Disposition",
      'attachment; filename="geramix-videos.zip"'
    );

    const archive =
      archiver(
        "zip",
        {
          zlib: {
            level: 0
          }
        }
      );

    archive.on(
      "error",
      error => {

        console.error(
          "Erro criando ZIP:",
          error
        );

        if (!res.headersSent) {

          res
            .status(500)
            .send(
              "Erro ao criar ZIP."
            );

        } else {

          res.destroy(error);

        }
      }
    );

    archive.pipe(res);

    try {

      for (
        const file
        of job.files
      ) {

        const tempVideo =
          await createVideoForJob(
            job,
            file
          );

        try {

          const input =
            fs.createReadStream(
              tempVideo
            );

          input.on(
            "error",
            error => {
              archive.emit(
                "error",
                error
              );
            }
          );

          archive.append(
            input,
            {
              name:
                file.name
            }
          );

          await new Promise(
            (resolve, reject) => {

              input.on(
                "end",
                resolve
              );

              input.on(
                "error",
                reject
              );

            }
          );

        } finally {

          await fsp.rm(
            tempVideo,
            {
              force: true
            }
          );

        }
      }

      await archive.finalize();

    } catch (error) {

      console.error(
        "Erro no download ZIP:",
        error
      );

      if (!res.headersSent) {

        return res
          .status(500)
          .send(
            "Erro ao criar ZIP."
          );
      }

      res.destroy(error);
    }

  }
);

/* =========================================================
   DOWNLOAD / VISUALIZAÇÃO DE VÍDEO
========================================================= */

app.get(
  "/api/jobs/:id/video/:name",

  requireAuth,

  async (req, res) => {

    const job =
      jobs.get(
        req.params.id
      );

    if (!job) {
      return res.sendStatus(404);
    }

    if (
      job.userId !==
      req.user.id
    ) {
      return res.sendStatus(404);
    }

    const name =
      safeName(
        req.params.name
      );

    const file =
      job.files.find(
        item =>
          item.name === name
      );

    if (!file) {
      return res.sendStatus(404);
    }

    let tempVideo = null;

    try {

      tempVideo =
        await createVideoForJob(
          job,
          file
        );

      const stat =
        await fsp.stat(
          tempVideo
        );

      const size =
        stat.size;

      const range =
        req.headers.range;

      res.setHeader(
        "Content-Type",
        "video/mp4"
      );

      res.setHeader(
        "Accept-Ranges",
        "bytes"
      );

      res.setHeader(
        "Cache-Control",
        "no-store"
      );

      if (!range) {

        res.setHeader(
          "Content-Length",
          size
        );

        res.setHeader(
          "Content-Disposition",
          `inline; filename="${name}"`
        );

        const stream =
          fs.createReadStream(
            tempVideo
          );

        stream.on(
          "close",
          () => {

            fsp.rm(
              tempVideo,
              {
                force: true
              }
            ).catch(() => {});

          }
        );

        stream.on(
          "error",
          error => {

            console.error(
              "Erro enviando vídeo:",
              error
            );

            fsp.rm(
              tempVideo,
              {
                force: true
              }
            ).catch(() => {});

            if (!res.headersSent) {

              res.sendStatus(500);

            } else {

              res.destroy(error);

            }

          }
        );

        return stream.pipe(res);
      }

      const matches =
        range.match(
          /bytes=(\d*)-(\d*)/
        );

      if (!matches) {

        await fsp.rm(
          tempVideo,
          {
            force: true
          }
        );

        return res
          .status(416)
          .set(
            "Content-Range",
            `bytes */${size}`
          )
          .end();
      }

      let start =
        matches[1]
          ? Number(matches[1])
          : 0;

      let end =
        matches[2]
          ? Number(matches[2])
          : size - 1;

      if (
        !matches[1] &&
        matches[2]
      ) {

        const suffixLength =
          Number(matches[2]);

        start =
          Math.max(
            0,
            size - suffixLength
          );

        end =
          size - 1;
      }

      if (
        start < 0 ||
        start >= size ||
        end < start
      ) {

        await fsp.rm(
          tempVideo,
          {
            force: true
          }
        );

        return res
          .status(416)
          .set(
            "Content-Range",
            `bytes */${size}`
          )
          .end();
      }

      end =
        Math.min(
          end,
          size - 1
        );

      const chunkSize =
        end - start + 1;

      res.statusCode = 206;

      res.setHeader(
        "Content-Range",
        `bytes ${start}-${end}/${size}`
      );

      res.setHeader(
        "Content-Length",
        chunkSize
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="${name}"`
      );

      const stream =
        fs.createReadStream(
          tempVideo,
          {
            start,
            end
          }
        );

      stream.on(
        "close",
        () => {

          fsp.rm(
            tempVideo,
            {
              force: true
            }
          ).catch(() => {});

        }
      );

      stream.on(
        "error",
        error => {

          console.error(
            "Erro enviando trecho do vídeo:",
            error
          );

          fsp.rm(
            tempVideo,
            {
              force: true
            }
          ).catch(() => {});

          if (!res.headersSent) {

            res.sendStatus(500);

          } else {

            res.destroy(error);

          }

        }
      );

      stream.pipe(res);

    } catch (error) {

      if (tempVideo) {

        await fsp.rm(
          tempVideo,
          {
            force: true
          }
        ).catch(() => {});

      }

      console.error(
        "Erro montando vídeo:",
        error
      );

      if (!res.headersSent) {

        return res
          .status(500)
          .send(
            "Erro ao montar o vídeo."
          );
      }

      res.destroy(error);
    }

  }
);

/* =========================================================
   ERROS
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {

    if (
      error instanceof
      multer.MulterError
    ) {

      console.error(
        "Erro Multer:",
        error
      );

      return res.status(400).json({
        error:
          "Erro no envio dos vídeos: " +
          error.message
      });
    }

    if (error) {

      console.error(
        "Erro no servidor:",
        error
      );

      return res.status(500).json({
        error:
          error.message ||
          "Erro interno do servidor."
      });
    }

    next();
  }
);

/* =========================================================
   SERVIDOR
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `GeraMix rodando na porta ${PORT}`
    );

    console.log(
      `FFmpeg simultâneos: ${FFMPEG_CONCURRENCY}`
    );

    console.log(
      `Modo de upload: ${
        process.env.VERCEL
          ? "Supabase Storage direto"
          : "Multipart"
      }`

  }
);
