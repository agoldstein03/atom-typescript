import {TypescriptServiceClient as Client} from "./client"
import * as path from "path"
import * as Resolve from "resolve"
import * as fs from "fs"
import {
  Diagnostic,
  DiagnosticEventBody,
  ConfigFileDiagnosticEventBody,
} from "typescript/lib/protocol"
import {Emitter} from "atom"

type DiagnosticTypes = protocol.DiagnosticEventKind | "configFileDiag"

interface DiagnosticsPayload {
  diagnostics: Diagnostic[]
  filePath: string
  serverPath: string
  type: DiagnosticTypes
}

interface Binary {
  version: string
  pathToBin: string
}

interface ClientRec {
  client: Client
  pending: string[]
}

export interface EventTypes {
  diagnostics: DiagnosticsPayload
  pendingRequestsChange: string[]
}

/**
 * ClientResolver takes care of finding the correct tsserver for a source file based on how a
 * require("typescript") from the same source file would resolve.
 */
export class ClientResolver {
  private clients = new Map<string, Map<string | undefined, ClientRec>>()
  private emitter = new Emitter<{}, EventTypes>()

  // This is just here so TypeScript can infer the types of the callbacks when using "on" method
  public on<T extends keyof EventTypes>(event: T, callback: (result: EventTypes[T]) => void) {
    return this.emitter.on(event, callback)
  }

  public *getAllPending(): IterableIterator<string> {
    for (const clientRec of this.getAllClients()) {
      yield* clientRec.pending
    }
  }

  public async killAllServers() {
    return Promise.all(
      Array.from(this.getAllClients()).map(clientRec => clientRec.client.killServer()),
    )
  }

  public async get(pFilePath: string): Promise<Client> {
    const {pathToBin, version} = await resolveBinary(pFilePath, "tsserver")
    const tsconfigPath = await resolveTsConfig(pFilePath)

    let tsconfigMap = this.clients.get(pathToBin)
    if (!tsconfigMap) {
      tsconfigMap = new Map()
      this.clients.set(pathToBin, tsconfigMap)
    }
    const clientRec = tsconfigMap.get(tsconfigPath)
    if (clientRec) return clientRec.client

    const newClientRec: ClientRec = {
      client: new Client(pathToBin, version),
      pending: [],
    }
    tsconfigMap.set(tsconfigPath, newClientRec)

    newClientRec.client.on("pendingRequestsChange", pending => {
      newClientRec.pending = pending
      this.emitter.emit("pendingRequestsChange", pending)
    })

    const diagnosticHandler = (type: DiagnosticTypes) => (
      result: DiagnosticEventBody | ConfigFileDiagnosticEventBody,
    ) => {
      const filePath = isConfDiagBody(result) ? result.configFile : result.file

      if (filePath) {
        this.emitter.emit("diagnostics", {
          type,
          serverPath: pathToBin,
          filePath,
          diagnostics: result.diagnostics,
        })
      }
    }

    newClientRec.client.on("configFileDiag", diagnosticHandler("configFileDiag"))
    newClientRec.client.on("semanticDiag", diagnosticHandler("semanticDiag"))
    newClientRec.client.on("syntaxDiag", diagnosticHandler("syntaxDiag"))
    newClientRec.client.on("suggestionDiag", diagnosticHandler("suggestionDiag"))

    return newClientRec.client
  }

  public dispose() {
    this.emitter.dispose()
  }

  private *getAllClients() {
    for (const tsconfigMap of this.clients.values()) {
      yield* tsconfigMap.values()
    }
  }
}

// Promisify the async resolve function
const resolveModule = (id: string, opts: Resolve.AsyncOpts): Promise<string> => {
  return new Promise<string>((resolve, reject) =>
    Resolve(id, opts, (err, result) => {
      if (err) {
        reject(err)
      } else {
        resolve(result)
      }
    }),
  )
}

export async function resolveBinary(sourcePath: string, binName: string): Promise<Binary> {
  const {NODE_PATH} = process.env as {NODE_PATH?: string}
  const defaultPath = require.resolve(`typescript/bin/${binName}`)

  const resolvedPath = await resolveModule(`typescript/bin/${binName}`, {
    basedir: path.dirname(sourcePath),
    paths: NODE_PATH !== undefined ? NODE_PATH.split(path.delimiter) : undefined,
  }).catch(() => defaultPath)

  const packagePath = path.resolve(resolvedPath, "../../package.json")
  // tslint:disable-next-line:no-unsafe-any
  const version: string = require(packagePath).version

  return {
    version,
    pathToBin: resolvedPath,
  }
}

async function fsexists(filePath: string): Promise<boolean> {
  return new Promise<boolean>(resolve => {
    fs.exists(filePath, resolve)
  })
}

async function resolveTsConfig(sourcePath: string): Promise<string | undefined> {
  let parentDir = path.dirname(sourcePath)
  let tsconfigPath = path.join(parentDir, "tsconfig.json")
  while (!(await fsexists(tsconfigPath))) {
    const oldParentDir = parentDir
    parentDir = path.dirname(parentDir)
    if (oldParentDir === parentDir) return undefined
    tsconfigPath = path.join(parentDir, "tsconfig.json")
  }
  return tsconfigPath
}

function isConfDiagBody(body: any): body is ConfigFileDiagnosticEventBody {
  // tslint:disable-next-line:no-unsafe-any
  return body && body.triggerFile && body.configFile
}
