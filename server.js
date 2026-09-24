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

const MAX_COMBINATIONS = 150;
const FFMPEG_CONCURRENCY = 1;
const DOWNLOAD_RETENTION_DAYS = 7;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "SUPABASE_URL e SUPABASE_ANON_KEY precisam estar configuradas."
  );
}

await Promise.all([
  fsp.mkdir(UPLOADS, { recursive: true }),
  fsp.mkdir(JOBS, { recursive: true })
]);

/* =========================================================
   EXPRESS
========================================================= */

app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
app.use(express.static(PUBLIC));

/* =========================================================
   CONFIGURAÇÃO DO FRONT-END
========================================================= */

app.get("/api/config", (_req, res) => {
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
      "GeraMix: erro ao validar sessão:",
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
    throw new Error(
      "Não foi possível verificar sua cota mensal."
    );
  }

  const data = await response.json();

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
      Number(result.videos_used || 0),

    monthlyLimit:
      Number(result.monthly_limit || 0),

    message:
      result.message || ""
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
      console.error(
        "GeraMix: não foi possível devolver a cota:",
        response.status
      );
    }
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

app.get("/health", (_req, res) => {
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
  return new Promise(
    (resolve, reject) => {
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

      let stderr = "";

      process.stderr.on(
        "data",
        data => {
          stderr += data.toString();

          if (stderr.length > 12000) {
            stderr =
              stderr.slice(-12000);
          }
        }
      );

      process.on(
        "error",
        reject
      );

      process.on(
        "close",
        code => {
          if (code === 0) {
            return resolve();
          }

          reject(
            new Error(
              stderr.trim() ||
              `FFmpeg saiu com código ${code}`
            )
          );
        }
      );
    }
  );
}

/* =========================================================
   VERIFICA ÁUDIO
========================================================= */

async function hasAudio(
  input,
  cwd
) {
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
    "scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p",

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

    "-movflags",
    "+faststart",

    "-y",
    output
  );

  await runFFmpeg(
    args,
    cwd
  );
}

/* =========================================================
   CONCATENA VÍDEOS NORMALIZADOS
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

        "-movflags",
        "+faststart",

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
   UTILITÁRIOS
========================================================= */

function safeName(name) {
  return String(
    name || "video"
  )
    .replace(
      /[^a-zA-Z0-9._-]/g,
      "_"
    )
    .slice(-100);
}

function encodeStoragePath(
  storagePath
) {
  return String(
    storagePath
  )
    .split("/")
    .map(
      encodeURIComponent
    )
    .join("/");
}

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

  return 70 +
    different * 10;
}

/* =========================================================
   STORAGE — BUSCAR OBJETO
========================================================= */

async function fetchStorageObject(
  storagePath,
  accessToken,
  range = null
) {
  const headers = {
    Authorization:
      `Bearer ${accessToken}`,

    apikey:
      SUPABASE_ANON_KEY
  };

  if (range) {
    headers.Range =
      range;
  }

  return fetch(
    `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodeStoragePath(storagePath)}`,
    {
      method: "GET",
      headers
    }
  );
}

/* =========================================================
   BAIXAR OBJETO DO STORAGE PARA /TMP
========================================================= */

async function downloadStorageObjectToFile(
  storagePath,
  accessToken,
  localPath
) {
  const response =
    await fetchStorageObject(
      storagePath,
      accessToken
    );

  if (
    !response.ok ||
    !response.body
  ) {
    throw new Error(
      `Não foi possível baixar o vídeo de origem do Storage (${response.status}).`
    );
  }

  const file =
    fs.createWriteStream(
      localPath
    );

  try {
    await new Promise(
      (
        resolve,
        reject
      ) => {
        const stream =
          Readable.fromWeb(
            response.body
          );

        stream.on(
          "error",
          reject
        );

        file.on(
          "error",
          reject
        );

        file.on(
          "finish",
          resolve
        );

        stream.pipe(file);
      }
    );
  } catch (error) {
    await fsp.rm(
      localPath,
      {
        force: true
      }
    );

    throw error;
  }
}

/* =========================================================
   ENVIAR VÍDEO PARA STORAGE
========================================================= */

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

  try {
    const response =
      await fetch(
        `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodeStoragePath(storagePath)}`,
        {
          method:
            "POST",

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
      throw new Error(
        `Supabase Storage recusou o vídeo (${response.status}).`
      );
    }

    return {
      storagePath,
      size:
        stat.size
    };
  } finally {
    stream.destroy();
  }
}

/* =========================================================
   EXCLUIR OBJETO DO STORAGE
========================================================= */

async function deleteStorageObject(
  storagePath,
  accessToken
) {
  const response =
    await fetch(
      `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodeStoragePath(storagePath)}`,
      {
        method:
          "DELETE",

        headers: {
          Authorization:
            `Bearer ${accessToken}`,

          apikey:
            SUPABASE_ANON_KEY
        }
      }
    );

  if (
    !response.ok &&
    response.status !== 404
  ) {
    throw new Error(
      `Supabase não conseguiu excluir o arquivo (${response.status}).`
    );
  }
}

/* =========================================================
   EXCLUIR VÁRIOS OBJETOS
========================================================= */

async function deleteStorageObjectsBestEffort(
  paths,
  accessToken
) {
  for (
    const storagePath of
    paths || []
  ) {
    if (!storagePath) {
      continue;
    }

    try {
      await deleteStorageObject(
        storagePath,
        accessToken
      );
    } catch (error) {
      console.error(
        "GeraMix: falha ao excluir objeto do Storage:",
        storagePath,
        error
      );
    }
  }
}

/* =========================================================
   REGISTRAR DOWNLOAD
========================================================= */

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
        method:
          "POST",

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
    throw new Error(
      `Supabase não conseguiu registrar o download (${response.status}).`
    );
  }
}

/* =========================================================
   EXCLUIR REGISTRO DE DOWNLOAD
========================================================= */

async function deleteDownloadRecord(
  id,
  accessToken
) {
  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/downloads?id=eq.${encodeURIComponent(id)}`,
      {
        method:
          "DELETE",

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

/* =========================================================
   LIMPEZA DE DOWNLOADS EXPIRADOS
========================================================= */

async function cleanupExpiredDownloads(
  userId,
  accessToken
) {
  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/downloads?user_id=eq.${encodeURIComponent(userId)}&expires_at=lt.${encodeURIComponent(new Date().toISOString())}&select=id,storage_path`,
      {
        method:
          "GET",

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

  const rows =
    await response.json();

  for (
    const row of
    Array.isArray(rows)
      ? rows
      : []
  ) {
    try {
      await deleteStorageObject(
        row.storage_path,
        accessToken
      );
    } catch (error) {
      console.error(
        "GeraMix: erro excluindo download expirado:",
        error
      );
    }

    try {
      await deleteDownloadRecord(
        row.id,
        accessToken
      );
    } catch (error) {
      console.error(
        "GeraMix: erro excluindo registro expirado:",
        error
      );
    }
  }
}

/* =========================================================
   CENTRAL DE DOWNLOADS
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

      const response =
        await fetch(
          `${SUPABASE_URL}/rest/v1/downloads?user_id=eq.${encodeURIComponent(req.user.id)}&order=created_at.desc`,
          {
            method:
              "GET",

            headers: {
              Authorization:
                `Bearer ${req.accessToken}`,

              apikey:
                SUPABASE_ANON_KEY
            }
          }
        );

      if (!response.ok) {
        return res.status(500).json({
          error:
            "Não foi possível carregar seus downloads."
        });
      }

      const rows =
        await response.json();

      return res.json(
        (
          Array.isArray(rows)
            ? rows
            : []
        ).map(
          row => ({
            id:
              row.id,

            jobId:
              row.job_id,

            fileName:
              row.file_name,

            originality:
              Number.isFinite(
                Number(
                  row.originality
                )
              )
                ? Number(
                    row.originality
                  )
                : null,

            createdAt:
              row.created_at,

            expiresAt:
              row.expires_at,

            videoUrl:
              `/api/downloads/${encodeURIComponent(row.id)}/video?token=${encodeURIComponent(req.accessToken)}`
          })
        )
      );
    } catch (error) {
      console.error(
        "GeraMix: erro na Central de Downloads:",
        error
      );

      return res.status(500).json({
        error:
          "Não foi possível carregar seus downloads."
      });
    }
  }
);

/* =========================================================
   EXCLUIR DOWNLOAD DA CENTRAL
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
            method:
              "GET",

            headers: {
              Authorization:
                `Bearer ${req.accessToken}`,

              apikey:
                SUPABASE_ANON_KEY
            }
          }
        );

      if (!response.ok) {
        return res.status(500).json({
          error:
            "Não foi possível localizar o download."
        });
      }

      const rows =
        await response.json();

      const row =
        Array.isArray(rows)
          ? rows[0]
          : null;

      if (!row) {
        return res.status(404).json({
          error:
            "Download não encontrado."
        });
      }

      await deleteStorageObject(
        row.storage_path,
        req.accessToken
      );

      await deleteDownloadRecord(
        row.id,
        req.accessToken
      );

      return res.json({
        ok: true
      });
    } catch (error) {
      console.error(
        "GeraMix: erro excluindo download:",
        error
      );

      return res.status(500).json({
        error:
          "Não foi possível excluir o download."
      });
    }
  }
);

/* =========================================================
   STREAM DE ARQUIVO DA CENTRAL
========================================================= */

async function streamStoredFile(
  file,
  req,
  res
) {
  const storagePath =
    file.storage_path ||
    file.storagePath;

  const response =
    await fetchStorageObject(
      storagePath,
      req.accessToken,
      req.headers.range || null
    );

  if (!response.ok) {
    return res.sendStatus(
      response.status === 404
        ? 404
        : 500
    );
  }

  res.status(
    response.status
  );

  res.setHeader(
    "Content-Type",
    response.headers.get(
      "content-type"
    ) || "video/mp4"
  );

  res.setHeader(
    "Accept-Ranges",
    "bytes"
  );

  res.setHeader(
    "Cache-Control",
    "private, no-store"
  );

  res.setHeader(
    "Content-Disposition",
    `inline; filename="${safeName(
      file.file_name ||
      file.name
    )}"`
  );

  const contentLength =
    response.headers.get(
      "content-length"
    );

  const contentRange =
    response.headers.get(
      "content-range"
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

  if (!response.body) {
    return res.end();
  }

  return Readable
    .fromWeb(
      response.body
    )
    .pipe(res);
}

/* =========================================================
   VISUALIZAÇÃO DA CENTRAL
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
            method:
              "GET",

            headers: {
              Authorization:
                `Bearer ${req.accessToken}`,

              apikey:
                SUPABASE_ANON_KEY
            }
          }
        );

      if (!response.ok) {
        return res.sendStatus(
          500
        );
      }

      const rows =
        await response.json();

      const file =
        Array.isArray(rows)
          ? rows[0]
          : null;

      if (!file) {
        return res.sendStatus(
          404
        );
      }

      return streamStoredFile(
        file,
        req,
        res
      );
    } catch (error) {
      console.error(
        "GeraMix: erro exibindo download:",
        error
      );

      return res.sendStatus(
        500
      );
    }
  }
);

/* =========================================================
   JOBS
========================================================= */

const jobs =
  new Map();

/* =========================================================
   RECUPERA JOB PELOS DOWNLOADS SALVOS
========================================================= */

async function getPersistentJobFromDownloads(
  id,
  userId,
  accessToken
) {
  const response =
    await fetch(
      `${SUPABASE_URL}/rest/v1/downloads?job_id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(userId)}&order=created_at.asc`,
      {
        method:
          "GET",

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
      "Não foi possível consultar os vídeos salvos."
    );
  }

  const rows =
    await response.json();

  if (
    !Array.isArray(rows) ||
    rows.length === 0
  ) {
    return null;
  }

  const files =
    rows.map(
      (
        row,
        index
      ) => ({
        name:
          row.file_name,

        originality:
          Number.isFinite(
            Number(
              row.originality
            )
          )
            ? Number(
                row.originality
              )
            : null,

        index:
          index + 1,

        stored:
          true,

        storagePath:
          row.storage_path,

        createdAt:
          row.created_at,

        expiresAt:
          row.expires_at
      })
    );

  return {
    id,

    userId,

    status:
      "done",

    total:
      files.length,

    done:
      files.length,

    current:
      "Concluído",

    files,

    error:
      null,

    zip:
      `/api/jobs/${id}/zip`
  };
}

function publicJob(job) {
  const copy =
    {
      ...job
    };

  delete copy.accessToken;
  delete copy.inputStoragePaths;

  return copy;
}

/* =========================================================
   MULTER — COMPATIBILIDADE
========================================================= */

const upload =
  multer({
    dest:
      UPLOADS,

    limits: {
      files:
        30,

      fileSize:
        200 * 1024 * 1024
    }
  });

/* =========================================================
   ENTRADAS VINDAS DO STORAGE
========================================================= */

function normalizeInputDescriptor(
  item
) {
  if (
    !item ||
    typeof item !==
      "object"
  ) {
    return null;
  }

  const storagePath =
    String(
      item.storagePath ||
      ""
    ).trim();

  const originalName =
    String(
      item.originalName ||
      item.originalname ||
      "video.mp4"
    ).trim();

  if (!storagePath) {
    return null;
  }

  return {
    storagePath,

    originalName:
      originalName ||
      "video.mp4"
  };
}

async function materializeStorageInputs(
  inputs,
  jobId,
  accessToken
) {
  const categories = {
    hooks:
      Array.isArray(
        inputs?.hooks
      )
        ? inputs.hooks
        : [],

    bodies:
      Array.isArray(
        inputs?.bodies
      )
        ? inputs.bodies
        : [],

    ctas:
      Array.isArray(
        inputs?.ctas
      )
        ? inputs.ctas
        : []
  };

  const result = {
    hooks: [],
    bodies: [],
    ctas: []
  };

  const paths = [];

  const dir =
    path.join(
      JOBS,
      jobId
    );

  for (
    const [
      category,
      rawItems
    ] of Object.entries(
      categories
    )
  ) {
    for (
      let index = 0;
      index < rawItems.length;
      index++
    ) {
      const item =
        normalizeInputDescriptor(
          rawItems[index]
        );

      if (!item) {
        throw new Error(
          `Entrada inválida em ${category}.`
        );
      }

      const localPath =
        path.join(
          dir,
          `source-${category}-${String(
            index + 1
          ).padStart(
            3,
            "0"
          )}-${crypto.randomUUID()}.mp4`
        );

      await downloadStorageObjectToFile(
        item.storagePath,
        accessToken,
        localPath
      );

      const file = {
        path:
          localPath,

        originalname:
          item.originalName,

        storagePath:
          item.storagePath
      };

      result[
        category
      ].push(file);

      paths.push(
        item.storagePath
      );
    }
  }

  return {
    ...result,

    inputStoragePaths:
      paths
  };
}

/* =========================================================
   ARQUIVOS NORMALIZADOS
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
      `hook-${String(
        file.hookIndex
      ).padStart(
        3,
        "0"
      )}.mp4`
    ),

    path.join(
      dir,
      `body-${String(
        file.bodyIndex
      ).padStart(
        3,
        "0"
      )}.mp4`
    ),

    path.join(
      dir,
      `cta-${String(
        file.ctaIndex
      ).padStart(
        3,
        "0"
      )}.mp4`
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

  try {
    await concatNormalized(
      getCombinationFiles(
        job,
        file
      ),
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
   CAMINHO DOS DOWNLOADS
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

/* =========================================================
   GERA + SALVA + REGISTRA VÍDEO
========================================================= */

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
      await deleteStorageObject(
        storagePath,
        accessToken
      ).catch(
        () => {}
      );

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
   PROCESSAMENTO
========================================================= */

async function processJob(
  job,
  source
) {
  const normalizedHooks =
    [];

  const normalizedBodies =
    [];

  const normalizedCtas =
    [];

  try {
    const hooks =
      source.hooks;

    const bodies =
      source.bodies;

    const ctas =
      source.ctas;

    const dir =
      path.join(
        JOBS,
        job.id
      );

    /* =====================================================
       1. GANCHOS
    ===================================================== */

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
          `hook-${String(
            i + 1
          ).padStart(
            3,
            "0"
          )}.mp4`
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
    }

    /* =====================================================
       2. CORPOS
    ===================================================== */

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
          `body-${String(
            i + 1
          ).padStart(
            3,
            "0"
          )}.mp4`
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
    }

    /* =====================================================
       3. CTAS
    ===================================================== */

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
          `cta-${String(
            i + 1
          ).padStart(
            3,
            "0"
          )}.mp4`
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
    }

    /* =====================================================
       4. CRIA COMBINAÇÕES
    ===================================================== */

    job.current =
      "Preparando combinações…";

    let index =
      0;

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

          const currentCombination =
            {
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
              `video-${String(
                index
              ).padStart(
                3,
                "0"
              )}.mp4`,

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

          job.done =
            index;
        }
      }
    }

    job.files.sort(
      (a, b) =>
        a.index -
        b.index
    );

    /* =====================================================
       5. SALVA OS VÍDEOS NO STORAGE
    ===================================================== */

    job.done =
      0;

    for (
      let i = 0;
      i < job.files.length;
      i++
    ) {
      const file =
        job.files[i];

      job.current =
        `Salvando vídeos: ${
          i + 1
        }/${job.files.length}`;

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

    /* =====================================================
       6. AGORA SIM APAGA OS VÍDEOS DE ENTRADA
    ===================================================== */

    await deleteStorageObjectsBestEffort(
      job.inputStoragePaths,
      job.accessToken
    );

    /* =====================================================
       7. FINALIZADO
    ===================================================== */

    job.current =
      "Concluído";

    job.status =
      "done";

    job.zip =
      `/api/jobs/${job.id}/zip`;

  } catch (error) {
    console.error(
      "GeraMix: erro no processamento:",
      error
    );

    /* =====================================================
       LIMPA VÍDEOS FINAIS SALVOS
    ===================================================== */

    for (
      const file of
      job.files.filter(
        item =>
          item.stored &&
          item.storagePath
      )
    ) {
      await deleteStorageObject(
        file.storagePath,
        job.accessToken
      ).catch(
        () => {}
      );
    }

    /* =====================================================
       LIMPA REGISTROS
    ===================================================== */

    await fetch(
      `${SUPABASE_URL}/rest/v1/downloads?job_id=eq.${encodeURIComponent(
        job.id
      )}&user_id=eq.${encodeURIComponent(
        job.userId
      )}`,
      {
        method:
          "DELETE",

        headers: {
          Authorization:
            `Bearer ${job.accessToken}`,

          apikey:
            SUPABASE_ANON_KEY
        }
      }
    ).catch(
      () => {}
    );

    /* =====================================================
       LIMPA INPUTS DO STORAGE
    ===================================================== */

    await deleteStorageObjectsBestEffort(
      job.inputStoragePaths,
      job.accessToken
    );

    /* =====================================================
       DEVOLVE COTA
    ===================================================== */

    await releaseVideoQuota(
      job.userId,
      job.accessToken,
      job.total
    );

    job.status =
      "error";

    job.error =
      error?.message ||
      "Erro desconhecido.";

    job.current =
      "Falhou";

  } finally {
    /* =====================================================
       LIMPA INPUTS LOCAIS
    ===================================================== */

    await Promise.all(
      [
        ...source.hooks,
        ...source.bodies,
        ...source.ctas
      ].map(
        file =>
          fsp.rm(
            file.path,
            {
              force: true
            }
          ).catch(
            () => {}
          )
      )
    );
  }
}

/* =========================================================
   PREPARAÇÃO MULTIPART
========================================================= */

async function prepareMultipartSource(
  req
) {
  return {
    hooks:
      req.files?.hooks ||
      [],

    bodies:
      req.files?.bodies ||
      [],

    ctas:
      req.files?.ctas ||
      [],

    inputStoragePaths:
      []
  };
}

/* =========================================================
   PREPARAÇÃO JSON
========================================================= */

async function prepareJsonSource(
  req,
  jobId
) {
  return materializeStorageInputs(
    req.body?.inputs,
    jobId,
    req.accessToken
  );
}

/* =========================================================
   CRIA JOB
========================================================= */

app.post(
  "/api/jobs",

  requireAuth,

  upload.fields([
    {
      name:
        "hooks",

      maxCount:
        5
    },

    {
      name:
        "bodies",

      maxCount:
        5
    },

    {
      name:
        "ctas",

      maxCount:
        6
    }
  ]),

  async (
    req,
    res
  ) => {
    const isJson =
      String(
        req.headers[
          "content-type"
        ] || ""
      )
        .toLowerCase()
        .includes(
          "application/json"
        );

    let id =
      crypto.randomUUID();

    let source =
      null;

    try {
      /* ===================================================
         NOVO FLUXO:
         JSON + ARQUIVOS JÁ NO SUPABASE STORAGE
      =================================================== */

      if (isJson) {
        source =
          await prepareJsonSource(
            req,
            id
          );
      } else {
        /* ================================================
           FLUXO ANTIGO:
           MULTIPART/MULTER
        ================================================ */

        source =
          await prepareMultipartSource(
            req
          );
      }

      const hooks =
        source.hooks || [];

      const bodies =
        source.bodies || [];

      const ctas =
        source.ctas || [];

      /* ===================================================
         VALIDA CATEGORIAS
      =================================================== */

      if (
        !hooks.length ||
        !bodies.length ||
        !ctas.length
      ) {
        await deleteStorageObjectsBestEffort(
          source.inputStoragePaths,
          req.accessToken
        );

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
              ).catch(
                () => {}
              )
          )
        );

        return res.status(400).json({
          error:
            "Envie pelo menos 1 vídeo em cada categoria."
        });
      }

      /* ===================================================
         CALCULA COMBINAÇÕES
      =================================================== */

      const total =
        hooks.length *
        bodies.length *
        ctas.length;

      if (
        total >
        MAX_COMBINATIONS
      ) {
        await deleteStorageObjectsBestEffort(
          source.inputStoragePaths,
          req.accessToken
        );

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
              ).catch(
                () => {}
              )
          )
        );

        return res.status(400).json({
          error:
            `Limite de ${MAX_COMBINATIONS} combinações por lote.`
        });
      }

      /* ===================================================
         RESERVA COTA
      =================================================== */

      const quota =
        await reserveVideoQuota(
          req.user.id,
          req.accessToken,
          total
        );

      if (!quota.allowed) {
        await deleteStorageObjectsBestEffort(
          source.inputStoragePaths,
          req.accessToken
        );

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
              ).catch(
                () => {}
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

      /* ===================================================
         CRIA PASTA DO JOB
      =================================================== */

      const dir =
        path.join(
          JOBS,
          id
        );

      await fsp.mkdir(
        dir,
        {
          recursive:
            true
        }
      );

      /* ===================================================
         OBJETO DO JOB
      =================================================== */

      const job = {
        id,

        userId:
          req.user.id,

        accessToken:
          req.accessToken,

        status:
          "processing",

        total,

        done:
          0,

        current:
          "Iniciando…",

        files:
          [],

        error:
          null,

        mode:
          isJson
            ? "storage-inputs"
            : "multipart",

        videosUsed:
          quota.videosUsed,

        monthlyLimit:
          quota.monthlyLimit,

        inputStoragePaths:
          source.inputStoragePaths ||
          [],

        zip:
          null
      };

      jobs.set(
        id,
        job
      );

      /* ===================================================
         RESPONDE RÁPIDO
      =================================================== */

      res.json({
        id,

        total,

        videosUsed:
          quota.videosUsed,

        monthlyLimit:
          quota.monthlyLimit
      });

      /* ===================================================
         INICIA PROCESSAMENTO
      =================================================== */

      void processJob(
        job,
        source
      );

    } catch (error) {
      console.error(
        "GeraMix: erro criando job:",
        error
      );

      if (source) {
        await deleteStorageObjectsBestEffort(
          source.inputStoragePaths,
          req.accessToken
        );

        await Promise.all(
          [
            ...(source.hooks ||
              []),

            ...(source.bodies ||
              []),

            ...(source.ctas ||
              [])
          ].map(
            file =>
              fsp.rm(
                file.path,
                {
                  force: true
                }
              ).catch(
                () => {}
              )
          )
        );
      }

      return res.status(500).json({
        error:
          error?.message ||
          "Não foi possível iniciar o processamento."
      });
    }
  }
);

/* =========================================================
   CONSULTA JOB
========================================================= */

app.get(
  "/api/jobs/:id",

  requireAuth,

  async (
    req,
    res
  ) => {
    try {
      let job =
        jobs.get(
          req.params.id
        );

      /* ================================================
         NÃO ESTÁ NA MEMÓRIA:
         TENTA RECUPERAR PELO SUPABASE
      ================================================ */

      if (!job) {
        job =
          await getPersistentJobFromDownloads(
            req.params.id,
            req.user.id,
            req.accessToken
          );

        if (!job) {
          return res.status(404).json({
            error:
              "Processamento não encontrado."
          });
        }

        return res.json(
          job
        );
      }

      /* ================================================
         GARANTE QUE O JOB É DO USUÁRIO
      ================================================ */

      if (
        job.userId !==
        req.user.id
      ) {
        return res.status(404).json({
          error:
            "Processamento não encontrado."
        });
      }

      return res.json(
        publicJob(job)
      );

    } catch (error) {
      console.error(
        "GeraMix: erro consultando job:",
        error
      );

      return res.status(500).json({
        error:
          "Não foi possível consultar o processamento."
      });
    }
  }
);

/* =========================================================
   PREVIEW DOS VÍDEOS DO JOB
   USA O STORAGE DIRETAMENTE
========================================================= */

app.get(
  "/api/jobs/:id/video/:name",

  requireAuth,

  async (
    req,
    res
  ) => {
    try {
      let job =
        jobs.get(
          req.params.id
        );

      if (!job) {
        job =
          await getPersistentJobFromDownloads(
            req.params.id,
            req.user.id,
            req.accessToken
          );
      }

      if (
        !job ||
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
            safeName(
              item.name
            ) === name
        );

      if (
        !file ||
        !file.storagePath
      ) {
        return res.sendStatus(
          404
        );
      }

      return streamStoredFile(
        {
          file_name:
            file.name,

          storage_path:
            file.storagePath
        },

        req,

        res
      );

    } catch (error) {
      console.error(
        "GeraMix: erro no preview:",
        error
      );

      return res.sendStatus(
        500
      );
    }
  }
);

/* =========================================================
   ZIP
   USA OS VÍDEOS JÁ SALVOS NO STORAGE
   NÃO REFAZ FFmpeg
========================================================= */

app.get(
  "/api/jobs/:id/zip",

  requireAuth,

  async (
    req,
    res
  ) => {
    let job;

    try {
      job =
        jobs.get(
          req.params.id
        );

      if (!job) {
        job =
          await getPersistentJobFromDownloads(
            req.params.id,
            req.user.id,
            req.accessToken
          );
      }

      if (
        !job ||
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
              level:
                0
            }
          }
        );

      archive.on(
        "error",
        error => {
          console.error(
            "GeraMix: erro criando ZIP:",
            error
          );

          if (
            !res.headersSent
          ) {
            res
              .status(
                500
              )
              .end();
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

      /* ================================================
         PEGA CADA VÍDEO DIRETO DO STORAGE
      ================================================ */

      for (
        const file of
        job.files
      ) {
        if (
          !file.storagePath
        ) {
          continue;
        }

        const response =
          await fetchStorageObject(
            file.storagePath,
            req.accessToken
          );

        if (
          !response.ok ||
          !response.body
        ) {
          throw new Error(
            `Não foi possível ler ${file.name} do Storage (${response.status}).`
          );
        }

        archive.append(
          Readable.fromWeb(
            response.body
          ),
          {
            name:
              file.name
          }
        );
      }

      await archive.finalize();

    } catch (error) {
      console.error(
        "GeraMix: erro no download ZIP:",
        error
      );

      if (
        !res.headersSent
      ) {
        return res
          .status(
            500
          )
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
   ERROS
========================================================= */

app.use(
  (
    error,
    _req,
    res,
    next
  ) => {
    if (
      error instanceof
      multer.MulterError
    ) {
      console.error(
        "GeraMix: erro Multer:",
        error
      );

      return res.status(400).json({
        error:
          `Erro no envio dos vídeos: ${error.message}`
      });
    }

    if (error) {
      console.error(
        "GeraMix: erro no servidor:",
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
      `Máximo de combinações: ${MAX_COMBINATIONS}`
    );
  }
);
