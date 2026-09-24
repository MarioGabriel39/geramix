import express from "express";
import multer from "multer";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawn } from "child_process";
import { Readable } from "stream";
import archiver from "archiver";
import ffmpegPath from "ffmpeg-static";

const app = express();

const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, "public");

const BASE = path.join(os.tmpdir(), "geramix");
const UPLOADS = path.join(BASE, "uploads");
const JOBS = path.join(BASE, "jobs");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const SUPABASE_DOWNLOAD_BUCKET = "geramix-downloads";

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "SUPABASE_URL e SUPABASE_ANON_KEY precisam estar configuradas."
  );
}

const MAX_HOOKS = 5;
const MAX_BODIES = 5;
const MAX_CTAS = 6;
const MAX_COMBINATIONS = 150;
const FFMPEG_CONCURRENCY = 1;

await Promise.all([
  fsp.mkdir(UPLOADS, { recursive: true }),
  fsp.mkdir(JOBS, { recursive: true })
]);

/* =========================================================
   ARQUIVOS PÚBLICOS
========================================================= */

app.use(express.static(PUBLIC));

/*
  O index.html novo envia JSON pequeno.
  Os vídeos grandes vão diretamente para o Supabase Storage.
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
  res.setHeader("Cache-Control", "no-store");

  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY
  });
});

/* =========================================================
   AUTENTICAÇÃO
========================================================= */

async function requireAuth(req, res, next) {
  try {
    const authorization = String(
      req.headers.authorization || ""
    ).trim();

    let token = "";

    if (authorization.toLowerCase().startsWith("bearer ")) {
      token = authorization.slice(7).trim();
    }

    if (!token) {
      token = String(req.query.token || "").trim();
    }

    if (!token) {
      return res.status(401).json({
        error: "Sessão não enviada."
      });
    }

    /*
      Publishable Key não é token de sessão.
    */
    if (token.startsWith("sb_")) {
      return res.status(401).json({
        error: "Token de usuário inválido."
      });
    }

    const response = await fetch(
      `${SUPABASE_URL}/auth/v1/user`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: SUPABASE_ANON_KEY
        }
      }
    );

    if (!response.ok) {
      let details = "";

      try {
        const data = await response.json();

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
        error: "Sessão inválida ou expirada."
      });
    }

    const user = await response.json();

    if (!user?.id) {
      return res.status(401).json({
        error: "Sessão inválida ou expirada."
      });
    }

    req.user = user;
    req.accessToken = token;

    next();
  } catch (error) {
    console.error(
      "Erro ao validar sessão:",
      error
    );

    return res.status(401).json({
      error: "Não foi possível validar sua sessão."
    });
  }
}

/* =========================================================
   COTA
========================================================= */

async function reserveVideoQuota(
  userId,
  accessToken,
  amount
) {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/rpc/reserve_video_quota`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
        apikey: SUPABASE_ANON_KEY
      },
      body: JSON.stringify({
        p_user_id: userId,
        p_amount: amount
      })
    }
  );

  if (!response.ok) {
    let details = "";

    try {
      const data = await response.json();

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

  const data = await response.json();

  const result = Array.isArray(data)
    ? data[0]
    : data;

  if (!result) {
    throw new Error(
      "O servidor não recebeu a resposta da cota."
    );
  }

  return {
    allowed: Boolean(result.allowed),
    videosUsed: Number(result.videos_used || 0),
    monthlyLimit: Number(result.monthly_limit || 0),
    message: result.message || ""
  };
}

async function releaseVideoQuota(
  userId,
  accessToken,
  amount
) {
  if (!amount || amount <= 0) {
    return;
  }

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/release_video_quota`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          apikey: SUPABASE_ANON_KEY
        },
        body: JSON.stringify({
          p_user_id: userId,
          p_amount: amount
        })
      }
    );

    if (!response.ok) {
      let details = "";

      try {
        const data = await response.json();

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
      `GeraMix: ${amount} vídeo(s) devolvido(s) para a cota.`
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
   FFMPEG
========================================================= */

function runFFmpeg(args, cwd) {
  return new Promise((resolve, reject) => {
    const process = spawn(
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

    let errorText = "";

    process.stderr.on("data", data => {
      errorText += data.toString();

      if (errorText.length > 10000) {
        errorText = errorText.slice(-10000);
      }
    });

    process.on("error", reject);

    process.on("close", code => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          errorText.trim() ||
          `FFmpeg saiu com código ${code}.`
        )
      );
    });
  });
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
   NORMALIZA VÍDEO
========================================================= */

async function normalizeVideo(
  input,
  output,
  cwd
) {
  const audio = await hasAudio(
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
   CONCATENA OS 3 VÍDEOS
========================================================= */

async function concatNormalized(
  files,
  output,
  cwd
) {
  const listFile = path.join(
    cwd,
    `concat-${crypto.randomUUID()}.txt`
  );

  const content = files
    .map(file => {
      const base = path
        .basename(file)
        .replace(/'/g, "'\\''");

      return `file '${base}'`;
    })
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
  return String(name || "video")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
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
   MULTER
   Mantido para compatibilidade.
========================================================= */

const upload = multer({
  dest: UPLOADS,

  limits: {
    files: 30,
    fileSize: 200 * 1024 * 1024
  }
});

/* =========================================================
   JOBS
========================================================= */

const jobs = new Map();

/* =========================================================
   STORAGE — DOWNLOAD DE ENTRADA
========================================================= */

/*
  O index.html envia somente o caminho do objeto.
  O servidor baixa o vídeo privado temporariamente
  para o /tmp e depois processa normalmente.
*/

function validateInputStoragePath(
  storagePath,
  userId
) {
  if (
    typeof storagePath !== "string" ||
    !storagePath.trim()
  ) {
    throw new Error(
      "Caminho de vídeo inválido."
    );
  }

  const normalized = storagePath
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");

  const prefix =
    `${userId}/inputs/`;

  if (!normalized.startsWith(prefix)) {
    throw new Error(
      "O vídeo enviado não pertence ao usuário."
    );
  }

  if (
    normalized.includes("..") ||
    normalized.includes("//")
  ) {
    throw new Error(
      "Caminho de vídeo inválido."
    );
  }

  return normalized;
}

async function downloadInputFromStorage(
  storagePath,
  destination,
  accessToken
) {
  const encodedPath = storagePath
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodedPath}`,
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
      const data =
        await response.json();

      details =
        data?.message ||
        data?.error ||
        data?.error_description ||
        "";
    } catch {
      details = "";
    }

    throw new Error(
      details ||
      `Não foi possível baixar o vídeo do Storage (${response.status}).`
    );
  }

  if (!response.body) {
    throw new Error(
      "O Storage não enviou o arquivo."
    );
  }

  const fileStream =
    fs.createWriteStream(
      destination
    );

  try {
    const readable =
      Readable.fromWeb(
        response.body
      );

    await new Promise(
      (resolve, reject) => {
        readable.on(
          "error",
          reject
        );

        fileStream.on(
          "error",
          reject
        );

        fileStream.on(
          "finish",
          resolve
        );

        readable.pipe(
          fileStream
        );
      }
    );
  } catch (error) {
    fileStream.destroy();

    await fsp.rm(
      destination,
      {
        force: true
      }
    ).catch(() => {});

    throw error;
  }
}

/* =========================================================
   STORAGE — EXCLUIR OBJETO
========================================================= */

async function deleteStorageObject(
  storagePath,
  accessToken
) {
  const encodedPath =
    storagePath
      .split("/")
      .map(encodeURIComponent)
      .join("/");

  const response = await fetch(
    `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodedPath}`,
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
    throw new Error(
      `Supabase não conseguiu excluir o arquivo (${response.status}).`
    );
  }
}

/* =========================================================
   CONVERTE INPUTS DO JSON EM ARQUIVOS LOCAIS
========================================================= */

async function materializeInputCategory(
  category,
  items,
  userId,
  accessToken,
  jobDir
) {
  if (!Array.isArray(items)) {
    throw new Error(
      `Categoria ${category} inválida.`
    );
  }

  const result = [];

  for (
    let index = 0;
    index < items.length;
    index++
  ) {
    const item = items[index];

    const storagePath =
      validateInputStoragePath(
        item?.storagePath,
        userId
      );

    const originalName =
      safeName(
        item?.originalName ||
        `${category}-${index + 1}.mp4`
      );

    const localPath =
      path.join(
        jobDir,
        `input-${category}-${String(index + 1).padStart(3, "0")}.mp4`
      );

    await downloadInputFromStorage(
      storagePath,
      localPath,
      accessToken
    );

    /*
      O arquivo original já está salvo localmente.
      Podemos apagar a cópia de entrada do Storage.
      Os vídeos finais ficam em outro caminho.
    */
    try {
      await deleteStorageObject(
        storagePath,
        accessToken
      );
    } catch (error) {
      /*
        Não derruba o processamento caso a limpeza
        da entrada falhe.
      */
      console.error(
        `GeraMix: não foi possível remover entrada ${storagePath}:`,
        error
      );
    }

    result.push({
      fieldname: category,
      originalname: originalName,
      encoding: "7bit",
      mimetype:
        item?.mimeType ||
        "video/mp4",
      destination: jobDir,
      filename:
        path.basename(localPath),
      path: localPath
    });
  }

  return result;
}

/* =========================================================
   ARQUIVOS DE COMBINAÇÃO
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

  return [
    path.join(
      dir,
      `hook-${String(file.hookIndex).padStart(3, "0")}.mp4`
    ),

    path.join(
      dir,
      `body-${String(file.bodyIndex).padStart(3, "0")}.mp4`
    ),

    path.join(
      dir,
      `cta-${String(file.ctaIndex).padStart(3, "0")}.mp4`
    )
  ];
}

/* =========================================================
   CRIA VÍDEO FINAL TEMPORÁRIO
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

  const output =
    path.join(
      dir,
      `temp-${crypto.randomUUID()}.mp4`
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
   CENTRAL DE DOWNLOADS — STORAGE
========================================================= */

function getDownloadStoragePath(
  userId,
  jobId,
  fileName
) {
  return [
    userId,
    jobId,
    safeName(fileName)
  ].join("/");
}

async function uploadVideoToStorage(
  localPath,
  storagePath,
  accessToken
) {
  const stat =
    await fsp.stat(
      localPath
    );

  const stream =
    fs.createReadStream(
      localPath
    );

  const encodedPath =
    storagePath
      .split("/")
      .map(encodeURIComponent)
      .join("/");

  try {
    const response =
      await fetch(
        `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodedPath}`,
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

          body: stream,

          duplex: "half"
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
          data?.error_description ||
          "";
      } catch {
        details = "";
      }

      throw new Error(
        details ||
        `Supabase Storage recusou o vídeo (${response.status}).`
      );
    }

    return {
      storagePath,
      size: stat.size
    };
  } finally {
    stream.destroy();
  }
}

async function registerDownload({
  userId,
  jobId,
  fileName,
  storagePath,
  originality,
  accessToken
}) {
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
              Number.isFinite(
                Number(originality)
              )
                ? Number(originality)
                : null
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

    throw new Error(
      details ||
      `Supabase não conseguiu registrar o download (${response.status}).`
    );
  }
}

async function createAndStoreDownload(
  job,
  file,
  accessToken
) {
  const tempVideo =
    await createVideoForJob(
      job,
      file
    );

  const storagePath =
    getDownloadStoragePath(
      job.userId,
      job.id,
      file.name
    );

  try {
    await uploadVideoToStorage(
      tempVideo,
      storagePath,
      accessToken
    );

    try {
      await registerDownload({
        userId:
          job.userId,

        jobId:
          job.id,

        fileName:
          file.name,

        storagePath,

        originality:
          file.originality,

        accessToken
      });
    } catch (error) {
      try {
        await deleteStorageObject(
          storagePath,
          accessToken
        );
      } catch (cleanupError) {
        console.error(
          "GeraMix: erro removendo arquivo órfão:",
          cleanupError
        );
      }

      throw error;
    }

    return storagePath;
  } finally {
    await fsp.rm(
      tempVideo,
      {
        force: true
      }
    );
  }
}

/* =========================================================
   CENTRAL DE DOWNLOADS — BANCO
========================================================= */

async function deleteDownloadRecord(
  id,
  accessToken
) {
  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/downloads?id=eq.${encodeURIComponent(id)}`,
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
    throw new Error(
      `Supabase não conseguiu excluir o registro (${response.status}).`
    );
  }
}

async function getUserDownloads(
  userId,
  accessToken
) {
  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/downloads?user_id=eq.${encodeURIComponent(userId)}&order=created_at.desc`,
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
    throw new Error(
      "Não foi possível carregar a Central de Downloads."
    );
  }

  return await response.json();
}

/*
  Remove arquivos expirados quando a Central é acessada.
*/
async function cleanupExpiredDownloads(
  userId,
  accessToken
) {
  const now =
    new Date().toISOString();

  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/downloads?user_id=eq.${encodeURIComponent(userId)}&expires_at=lt.${encodeURIComponent(now)}&select=id,storage_path`,
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
    return;
  }

  const expired =
    await response.json();

  for (const item of expired) {
    try {
      await deleteStorageObject(
        item.storage_path,
        accessToken
      );
    } catch (error) {
      console.error(
        "GeraMix: erro removendo download expirado:",
        error
      );
    }

    try {
      await deleteDownloadRecord(
        item.id,
        accessToken
      );
    } catch (error) {
      console.error(
        "GeraMix: erro removendo registro expirado:",
        error
      );
    }
  }
}

/* =========================================================
   API CENTRAL DE DOWNLOADS
========================================================= */

app.get(
  "/api/downloads",
  requireAuth,
  async (req, res) => {
    try {
      await cleanupExpiredDownloads(
        req.user.id,
        req.accessToken
      );

      const downloads =
        await getUserDownloads(
          req.user.id,
          req.accessToken
        );

      res.json({
        downloads
      });
    } catch (error) {
      console.error(
        "Erro carregando downloads:",
        error
      );

      res.status(500).json({
        error:
          error?.message ||
          "Erro ao carregar downloads."
      });
    }
  }
);

/* =========================================================
   VISUALIZAÇÃO / DOWNLOAD DA CENTRAL
========================================================= */

app.get(
  "/api/downloads/:id/video",
  requireAuth,
  async (req, res) => {
    try {
      const response =
        await fetch(
          `${SUPABASE_URL}/rest/v1/downloads?id=eq.${encodeURIComponent(req.params.id)}&user_id=eq.${encodeURIComponent(req.user.id)}&select=id,file_name,storage_path,expires_at`,
          {
            method: "GET",

            headers: {
              Authorization:
                `Bearer ${req.accessToken}`,

              apikey:
                SUPABASE_ANON_KEY
            }
          }
        );

      if (!response.ok) {
        return res.sendStatus(404);
      }

      const rows =
        await response.json();

      const item =
        rows[0];

      if (!item) {
        return res.sendStatus(404);
      }

      if (
        new Date(item.expires_at).getTime() <=
        Date.now()
      ) {
        try {
          await deleteStorageObject(
            item.storage_path,
            req.accessToken
          );
        } catch {}

        try {
          await deleteDownloadRecord(
            item.id,
            req.accessToken
          );
        } catch {}

        return res.sendStatus(404);
      }

      const encodedPath =
        item.storage_path
          .split("/")
          .map(encodeURIComponent)
          .join("/");

      const headers = {
        Authorization:
          `Bearer ${req.accessToken}`,

        apikey:
          SUPABASE_ANON_KEY
      };

      if (req.headers.range) {
        headers.Range =
          req.headers.range;
      }

      const storageResponse =
        await fetch(
          `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodedPath}`,
          {
            method: "GET",
            headers
          }
        );

      if (!storageResponse.ok) {
        return res.sendStatus(
          storageResponse.status === 404
            ? 404
            : 500
        );
      }

      res.status(
        storageResponse.status
      );

      res.setHeader(
        "Content-Type",
        storageResponse.headers.get(
          "content-type"
        ) || "video/mp4"
      );

      const contentLength =
        storageResponse.headers.get(
          "content-length"
        );

      const contentRange =
        storageResponse.headers.get(
          "content-range"
        );

      const acceptRanges =
        storageResponse.headers.get(
          "accept-ranges"
        );

      if (contentLength) {
        res.setHeader(
          "Content-Length",
          contentLength
        );
      }

      if (contentRange) {
        res.setHeader(
          "Content-Range",
          contentRange
        );
      }

      if (acceptRanges) {
        res.setHeader(
          "Accept-Ranges",
          acceptRanges
        );
      } else {
        res.setHeader(
          "Accept-Ranges",
          "bytes"
        );
      }

      res.setHeader(
        "Cache-Control",
        "private, no-store"
      );

      res.setHeader(
        "Content-Disposition",
        `inline; filename="${safeName(item.file_name)}"`
      );

      if (!storageResponse.body) {
        return res.end();
      }

      Readable.fromWeb(
        storageResponse.body
      ).pipe(res);
    } catch (error) {
      console.error(
        "Erro entregando download:",
        error
      );

      if (!res.headersSent) {
        res.status(500).send(
          "Erro ao abrir o vídeo."
        );
      } else {
        res.destroy(error);
      }
    }
  }
);

/* =========================================================
   EXCLUI DOWNLOAD DA CENTRAL
========================================================= */

app.delete(
  "/api/downloads/:id",
  requireAuth,
  async (req, res) => {
    try {
      const response =
        await fetch(
          `${SUPABASE_URL}/rest/v1/downloads?id=eq.${encodeURIComponent(req.params.id)}&user_id=eq.${encodeURIComponent(req.user.id)}&select=id,storage_path`,
          {
            method: "GET",

            headers: {
              Authorization:
                `Bearer ${req.accessToken}`,

              apikey:
                SUPABASE_ANON_KEY
            }
          }
        );

      if (!response.ok) {
        return res.status(404).json({
          error:
            "Download não encontrado."
        });
      }

      const rows =
        await response.json();

      const item =
        rows[0];

      if (!item) {
        return res.status(404).json({
          error:
            "Download não encontrado."
        });
      }

      try {
        await deleteStorageObject(
          item.storage_path,
          req.accessToken
        );
      } catch (error) {
        console.error(
          "GeraMix: erro excluindo arquivo:",
          error
        );
      }

      await deleteDownloadRecord(
        item.id,
        req.accessToken
      );

      res.json({
        ok: true
      });
    } catch (error) {
      console.error(
        "Erro excluindo download:",
        error
      );

      res.status(500).json({
        error:
          error?.message ||
          "Erro ao excluir download."
      });
    }
  }
);

/* =========================================================
   CRIA JOB
========================================================= */

app.post(
  "/api/jobs",
  requireAuth,

  /*
    Multer continua aceitando o formato antigo.
    O novo index.html envia JSON.
  */
  upload.fields([
    {
      name: "hooks",
      maxCount: MAX_HOOKS
    },
    {
      name: "bodies",
      maxCount: MAX_BODIES
    },
    {
      name: "ctas",
      maxCount: MAX_CTAS
    }
  ]),

  async (req, res) => {
    let hooks = [];
    let bodies = [];
    let ctas = [];

    let usingStorageInputs = false;

    /*
      ======================================================
      NOVO FORMATO
      JSON:
      {
        inputs: {
          hooks: [...],
          bodies: [...],
          ctas: [...]
        }
      }
      ======================================================
    */

    if (
      req.body &&
      req.body.inputs
    ) {
      usingStorageInputs = true;

      const inputs =
        req.body.inputs;

      if (
        !Array.isArray(inputs.hooks) ||
        !Array.isArray(inputs.bodies) ||
        !Array.isArray(inputs.ctas)
      ) {
        return res.status(400).json({
          error:
            "Os vídeos enviados estão em formato inválido."
        });
      }

      if (
        inputs.hooks.length < 1 ||
        inputs.bodies.length < 1 ||
        inputs.ctas.length < 1
      ) {
        return res.status(400).json({
          error:
            "Envie pelo menos 1 vídeo em cada categoria."
        });
      }

      if (
        inputs.hooks.length > MAX_HOOKS ||
        inputs.bodies.length > MAX_BODIES ||
        inputs.ctas.length > MAX_CTAS
      ) {
        return res.status(400).json({
          error:
            "Quantidade de vídeos acima do limite permitido."
        });
      }

      const total =
        inputs.hooks.length *
        inputs.bodies.length *
        inputs.ctas.length;

      if (
        total >
        MAX_COMBINATIONS
      ) {
        return res.status(400).json({
          error:
            `Limite de ${MAX_COMBINATIONS} combinações por lote.`
        });
      }

      const id =
        crypto.randomUUID();

      const dir =
        path.join(
          JOBS,
          id
        );

      try {
        await fsp.mkdir(
          dir,
          {
            recursive: true
          }
        );

        /*
          Baixa os arquivos enviados ao Storage
          para o processamento temporário.
        */
        hooks =
          await materializeInputCategory(
            "hooks",
            inputs.hooks,
            req.user.id,
            req.accessToken,
            dir
          );

        bodies =
          await materializeInputCategory(
            "bodies",
            inputs.bodies,
            req.user.id,
            req.accessToken,
            dir
          );

        ctas =
          await materializeInputCategory(
            "ctas",
            inputs.ctas,
            req.user.id,
            req.accessToken,
            dir
          );
      } catch (error) {
        await fsp.rm(
          dir,
          {
            recursive: true,
            force: true
          }
        ).catch(() => {});

        return res.status(400).json({
          error:
            error?.message ||
            "Não foi possível preparar os vídeos enviados."
        });
      }

      await startJobProcessing({
        req,
        res,
        id,
        dir,
        hooks,
        bodies,
        ctas,
        total
      });

      return;
    }

    /*
      ======================================================
      FORMATO ANTIGO — MULTIPART
      ======================================================
    */

    hooks =
      req.files?.hooks || [];

    bodies =
      req.files?.bodies || [];

    ctas =
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

    if (
      hooks.length > MAX_HOOKS ||
      bodies.length > MAX_BODIES ||
      ctas.length > MAX_CTAS
    ) {
      await removeUploadedFiles([
        ...hooks,
        ...bodies,
        ...ctas
      ]);

      return res.status(400).json({
        error:
          "Quantidade de vídeos acima do limite permitido."
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
      await removeUploadedFiles([
        ...hooks,
        ...bodies,
        ...ctas
      ]);

      return res.status(400).json({
        error:
          `Limite de ${MAX_COMBINATIONS} combinações por lote.`
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

    await startJobProcessing({
      req,
      res,
      id,
      dir,
      hooks,
      bodies,
      ctas,
      total
    });
  }
);

/* =========================================================
   REMOVE UPLOADS
========================================================= */

async function removeUploadedFiles(
  files
) {
  await Promise.all(
    files.map(
      file =>
        file?.path
          ? fsp.rm(
              file.path,
              {
                force: true
              }
            )
          : Promise.resolve()
    )
  );
}

/* =========================================================
   PROCESSAMENTO DO JOB
========================================================= */

async function startJobProcessing({
  req,
  res,
  id,
  dir,
  hooks,
  bodies,
  ctas,
  total
}) {
  let quota;

  try {
    quota =
      await reserveVideoQuota(
        req.user.id,
        req.accessToken,
        total
      );
  } catch (error) {
    await removeUploadedFiles([
      ...hooks,
      ...bodies,
      ...ctas
    ]);

    await fsp.rm(
      dir,
      {
        recursive: true,
        force: true
      }
    ).catch(() => {});

    return res.status(503).json({
      error:
        error?.message ||
        "Não foi possível verificar sua cota mensal."
    });
  }

  if (!quota.allowed) {
    await removeUploadedFiles([
      ...hooks,
      ...bodies,
      ...ctas
    ]);

    await fsp.rm(
      dir,
      {
        recursive: true,
        force: true
      }
    ).catch(() => {});

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

  const job = {
    id,

    userId:
      req.user.id,

    /*
      IMPORTANTE:
      o token precisa ficar disponível durante
      o processamento assíncrono.
    */
    accessToken:
      req.accessToken,

    status:
      "processing",

    total,

    done:
      0,

    current:
      "Iniciando…",

    files: [],

    error:
      null,

    mode:
      "storage-inputs",

    videosUsed:
      quota.videosUsed,

    monthlyLimit:
      quota.monthlyLimit,

    zip:
      null
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

  /*
    O restante roda em segundo plano.
  */
  (async () => {
    const normalizedHooks = [];
    const normalizedBodies = [];
    const normalizedCtas = [];

    try {
      /* ================================================
         1. GANCHOS
      ================================================ */

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

      /* ================================================
         2. CORPOS
      ================================================ */

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

      /* ================================================
         3. CTAs
      ================================================ */

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

      /* ================================================
         4. COMBINAÇÕES
      ================================================ */

      job.current =
        "Preparando combinações…";

      let index = 0;

      for (
        let hookIndex = 0;
        hookIndex < normalizedHooks.length;
        hookIndex++
      ) {
        for (
          let bodyIndex = 0;
          bodyIndex < normalizedBodies.length;
          bodyIndex++
        ) {
          for (
            let ctaIndex = 0;
            ctaIndex < normalizedCtas.length;
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

              originality,

              stored:
                false,

              storagePath:
                null
            });
          }
        }
      }

      /* ================================================
         5. SALVA UM VÍDEO POR VEZ
      ================================================ */

      job.done = 0;

      for (
        let i = 0;
        i < job.files.length;
        i++
      ) {
        const file =
          job.files[i];

        job.current =
          `Salvando vídeos: ${i + 1}/${job.files.length}`;

        const storagePath =
          await createAndStoreDownload(
            job,
            file,
            job.accessToken
          );

        file.stored =
          true;

        file.storagePath =
          storagePath;

        job.done =
          i + 1;
      }

      /* ================================================
         6. FINALIZADO
      ================================================ */

      job.current =
        "Concluído";

      job.status =
        "done";

      job.zip =
        `/api/jobs/${id}/zip`;
    } catch (error) {
      console.error(
        "GeraMix: erro no processamento:",
        error
      );

      /*
        Remove vídeos finais que já chegaram ao Storage.
      */
      for (
        const storedFile
        of job.files.filter(
          file =>
            file.stored &&
            file.storagePath
        )
      ) {
        try {
          await deleteStorageObject(
            storedFile.storagePath,
            job.accessToken
          );
        } catch (cleanupError) {
          console.error(
            "GeraMix: erro removendo vídeo após falha:",
            cleanupError
          );
        }
      }

      /*
        Remove registros do banco desse job.
      */
      try {
        const response =
          await fetch(
            `${SUPABASE_URL}/rest/v1/downloads?job_id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(req.user.id)}`,
            {
              method: "DELETE",

              headers: {
                Authorization:
                  `Bearer ${req.accessToken}`,

                apikey:
                  SUPABASE_ANON_KEY
              }
            }
          );

        if (!response.ok) {
          console.error(
            "GeraMix: erro limpando registros do job.",
            response.status
          );
        }
      } catch (cleanupError) {
        console.error(
          "GeraMix: erro limpando registros:",
          cleanupError
        );
      }

      /*
        Devolve toda a cota reservada.
      */
      await releaseVideoQuota(
        req.user.id,
        req.accessToken,
        total
      );

      job.status =
        "error";

      job.error =
        error?.message ||
        "Erro desconhecido.";

      job.current =
        "Falhou";
    }
  })();
}

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

    /*
      Não devolvemos o accessToken para o navegador.
    */
    const response = {
      ...job
    };

    delete response.accessToken;

    res.json(
      response
    );
  }
);

/* =========================================================
   ZIP
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

    res.statusCode =
      200;

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
          res.destroy(
            error
          );
        }
      }
    );

    archive.pipe(
      res
    );

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
          archive.file(
            tempVideo,
            {
              name:
                file.name
            }
          );
        } catch (error) {
          await fsp.rm(
            tempVideo,
            {
              force: true
            }
          );

          throw error;
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

      res.destroy(
        error
      );
    }
  }
);

/* =========================================================
   PREVIEW DE VÍDEO DO JOB
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
      return res.sendStatus(
        404
      );
    }

    if (
      job.userId !==
      req.user.id
    ) {
      return res.sendStatus(
        404
      );
    }

    const name =
      safeName(
        req.params.name
      );

    const file =
      job.files.find(
        item =>
          item.name ===
          name
      );

    if (!file) {
      return res.sendStatus(
        404
      );
    }

    let tempVideo =
      null;

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
            ).catch(
              () => {}
            );
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
            ).catch(
              () => {}
            );

            if (!res.headersSent) {
              res.sendStatus(
                500
              );
            } else {
              res.destroy(
                error
              );
            }
          }
        );

        return stream.pipe(
          res
        );
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
            size -
              suffixLength
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
        end -
        start +
        1;

      res.statusCode =
        206;

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
          ).catch(
            () => {}
          );
        }
      );

      stream.on(
        "error",
        error => {
          console.error(
            "Erro enviando trecho:",
            error
          );

          fsp.rm(
            tempVideo,
            {
              force: true
            }
          ).catch(
            () => {}
          );

          if (!res.headersSent) {
            res.sendStatus(
              500
            );
          } else {
            res.destroy(
              error
            );
          }
        }
      );

      stream.pipe(
        res
      );
    } catch (error) {
      if (tempVideo) {
        await fsp.rm(
          tempVideo,
          {
            force: true
          }
        ).catch(
          () => {}
        );
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

      res.destroy(
        error
      );
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
  }
);
