import * as piClient from "@earendil-works/pi-coding-agent/client";
import * as pi from "@earendil-works/pi-coding-agent";

export interface HostCapabilityReport {
  piVersion: string;
  globalPackage: boolean;
  rpcWorker: boolean;
  daemonOwnedStartup: boolean;
  nativeAttach: boolean;
  composableLeftGesture: boolean;
  fullscreenCustomUi: boolean;
  blockers: readonly string[];
}

export type HostCapabilityEvidence = Omit<HostCapabilityReport, "blockers">;
export type HostCapabilityProbe = () => Promise<HostCapabilityEvidence>;

async function canResolvePublicRpcEntry(): Promise<boolean> {
  try {
    import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry");
    return true;
  } catch {
    return false;
  }
}

function hasApprovedDaemonOwnedStartupContract(): false {
  return false;
}

function hasApprovedNativeAttachContract(): false {
  return false;
}

async function probeInstalledHost(): Promise<HostCapabilityEvidence> {
  const publicPi = pi as Record<string, unknown>;
  const publicClient = piClient as Record<string, unknown>;
  const extensionRuntime = typeof publicPi.createExtensionRuntime === "function";
  const remoteSessionClient = typeof publicClient.RemoteSession === "function";

  return {
    piVersion: typeof publicPi.VERSION === "string" ? publicPi.VERSION : "unknown",
    globalPackage: typeof publicPi.DefaultPackageManager === "function" && extensionRuntime,
    rpcWorker: typeof publicPi.RpcClient === "function" && await canResolvePublicRpcEntry(),
    daemonOwnedStartup: hasApprovedDaemonOwnedStartupContract(),
    nativeAttach: remoteSessionClient && hasApprovedNativeAttachContract(),
    composableLeftGesture: typeof publicPi.CustomEditor === "function" && extensionRuntime,
    fullscreenCustomUi: typeof publicPi.InteractiveMode === "function" && extensionRuntime,
  };
}

function capabilityBlockers(evidence: HostCapabilityEvidence): readonly string[] {
  const version = evidence.piVersion;
  return [
    evidence.globalPackage
      ? undefined
      : `Pi ${version} does not expose the documented public package and extension runtime APIs.`,
    evidence.rpcWorker
      ? undefined
      : `Pi ${version} does not expose both RpcClient and the public rpc-entry subpath.`,
    evidence.daemonOwnedStartup
      ? undefined
      : `Pi ${version} has no documented public extension startup hook for selecting a daemon-owned backend before the model loop starts.`,
    evidence.nativeAttach
      ? undefined
      : `Pi ${version} has no documented public native attachment adapter that binds InteractiveMode to a daemon-owned remote session.`,
    evidence.composableLeftGesture
      ? undefined
      : `Pi ${version} does not expose the documented extension editor composition APIs needed for the Left gesture.`,
    evidence.fullscreenCustomUi
      ? undefined
      : `Pi ${version} does not expose the documented interactive and extension runtime APIs needed for custom UI.`,
  ].filter((blocker): blocker is string => blocker !== undefined);
}

export async function checkHostCapabilities(
  probe: HostCapabilityProbe = probeInstalledHost,
): Promise<HostCapabilityReport> {
  try {
    const evidence = await probe();
    return {
      ...evidence,
      blockers: capabilityBlockers(evidence),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      piVersion: "unknown",
      globalPackage: false,
      rpcWorker: false,
      daemonOwnedStartup: false,
      nativeAttach: false,
      composableLeftGesture: false,
      fullscreenCustomUi: false,
      blockers: [`Pi host capability inspection failed closed: ${detail}`],
    };
  }
}
