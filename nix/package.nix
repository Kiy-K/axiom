{
  autoPatchelfHook,
  bun,
  fd,
  fetchurl,
  importNpmLock,
  lib,
  libxcb,
  makeWrapper,
  nodejs_26,
  ripgrep,
  rustPlatform,
  source,
  stdenv,
  wl-clipboard,
  xclip,
}:

let
  nodejs = nodejs_26;
  # The build runs `bun run build` in every package, so it needs Bun, as CI does. CI pins Bun 1.4.4; the pinned nixpkgs
  # has 1.3.13 without an Intel macOS build, so take 1.4.4 from its release zips (hashes from those files).
  bunPinned = bun.overrideAttrs (old: {
    version = "1.4.4";
    passthru = old.passthru // {
      sources = {
        "aarch64-darwin" = fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-darwin-aarch64.zip";
          hash = "sha256-wkDX8My5DCY6hJ/NsJt+5iYw2SE0jtaq/ahrnVd7xRA=";
        };
        "aarch64-linux" = fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-aarch64.zip";
          hash = "sha256-uqa7NvUdblhWHgK76oJQOKnfRU9nPW13bou/hvjHhQ4=";
        };
        "x86_64-darwin" = fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-darwin-x64-baseline.zip";
          hash = "sha256-1KFVrfv9CRVes7oFyeOlRPOSl9emhhbTx3WfZ6tcR9w=";
        };
        "x86_64-linux" = fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64-baseline.zip";
          hash = "sha256-4ERutVmVdy65iUvrrppr42jZhai5Jx7hJEhvmUbu3XY=";
        };
      };
    };
  });
  packageJson = lib.importJSON (source + "/packages/coding-agent/package.json");
  # Lockfile root used by the pi.dev installer. It pins the coding agent's
  # runtime dependency tree and is kept in sync with package-lock.json by
  # `npm run check`.
  installLock = source + "/packages/coding-agent/install-lock";
  modelCatalogPin = lib.importJSON ./model-catalog.json;
  modelCatalog = fetchurl {
    name = "pi-model-catalog.json";
    # The typed catalog is the representation whose bytes the revision hashes.
    url = "https://pi.dev/api/models/revisions/${modelCatalogPin.revision}?types=chat,image,classifier";
    sha256 = lib.removePrefix "sha256-" modelCatalogPin.revision;
  };

  processHelper = rustPlatform.buildRustPackage {
    pname = "axiom-process";
    inherit (packageJson) version;
    src = source;
    cargoRoot = "packages/env/daemon";
    # cargoRoot only locates Cargo.lock; cargo build stays at the source root without this.
    buildAndTestSubdir = "packages/env/daemon";
    cargoLock.lockFile = source + "/packages/env/daemon/Cargo.lock";
    cargoBuildFlags = [ "--bin" "axiom-process" ];
    doCheck = false;
  };

  workspacePackages = stdenv.mkDerivation {
    pname = "pi-workspace-packages";
    inherit (packageJson) version;
    src = source;

    npmDeps = importNpmLock { npmRoot = source; };
    npmRebuildFlags = [ "--ignore-scripts" ];

    nativeBuildInputs = [
      nodejs
      bunPinned
      importNpmLock.npmConfigHook
    ];

    buildPhase = ''
      runHook preBuild
      node packages/ai/scripts/hydrate-model-catalog.ts ${modelCatalog}
      helper_platform="$(node -p 'process.platform + "-" + process.arch')"
      mkdir -p "packages/coding-agent/native/process/$helper_platform"
      cp ${processHelper}/bin/axiom-process "packages/coding-agent/native/process/$helper_platform/axiom-process"
      export AXIOM_NATIVE_PROCESS_PREBUILT=1
      npm run build:offline
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      pack_package() {
        local package_dir="$1"
        local output_name="$2"
        local tarball

        tarball="$(cd "$package_dir" && npm pack --ignore-scripts --silent --pack-destination "$TMPDIR")"
        mv "$TMPDIR/$tarball" "$out/$output_name.tgz"
      }

      mkdir -p "$out"
      pack_package packages/telemetry telemetry
      pack_package packages/schema schema
      pack_package packages/ai ai
      pack_package packages/tui tui
      pack_package packages/agent agent
      pack_package packages/codemode codemode
      pack_package packages/mcp mcp
      pack_package packages/coding-agent coding-agent

      runHook postInstall
    '';
  };

  npmDeps = importNpmLock {
    npmRoot = installLock;
    # The install lock points internal packages at registry releases. Replace
    # them with the packages built from this checkout.
    packageSourceOverrides = {
      "node_modules/@earendil-works/pi-agent-core" = workspacePackages + "/agent.tgz";
      "node_modules/@earendil-works/pi-ai" = workspacePackages + "/ai.tgz";
      "node_modules/@earendil-works/pi-codemode" = workspacePackages + "/codemode.tgz";
      "node_modules/@earendil-works/pi-coding-agent" = workspacePackages + "/coding-agent.tgz";
      "node_modules/@earendil-works/pi-mcp" = workspacePackages + "/mcp.tgz";
      "node_modules/@earendil-works/pi-schema" = workspacePackages + "/schema.tgz";
      "node_modules/@earendil-works/pi-telemetry" = workspacePackages + "/telemetry.tgz";
      "node_modules/@earendil-works/pi-tui" = workspacePackages + "/tui.tgz";
    };
  };
in
stdenv.mkDerivation {
  pname = "axiom";
  inherit (packageJson) version;
  src = installLock;
  inherit npmDeps;

  npmRebuildFlags = [ "--ignore-scripts" ];

  nativeBuildInputs = [
    nodejs
    importNpmLock.npmConfigHook
    makeWrapper
  ]
  ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];

  buildInputs = [ nodejs ] ++ lib.optionals stdenv.hostPlatform.isLinux [
    stdenv.cc.cc.lib
    libxcb
  ];

  dontBuild = true;
  dontStrip = true;

  installPhase = ''
    runHook preInstall

    mkdir -p "$out/lib/axiom" "$out/bin"
    cp -R . "$out/lib/axiom"

    # The wrapper runs Pi with an absolute Node path. Node is only on PATH so Pi can
    # find npm for package installs; append it so that shells started by the
    # bash tool keep the user's node/npm (e.g. from mise or nvm). fd, ripgrep,
    # and the clipboard tools are Pi's own dependencies and take precedence.
    makeWrapper ${nodejs}/bin/node "$out/bin/axiom" \
      --add-flags "$out/lib/axiom/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" \
      --suffix PATH : ${lib.makeBinPath [ nodejs ]} \
      --prefix PATH : ${
        lib.makeBinPath (
          [
            fd
            ripgrep
          ]
          ++ lib.optionals stdenv.hostPlatform.isLinux [
            wl-clipboard
            xclip
          ]
        )
      }

    runHook postInstall
  '';

  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    test "$("$out/bin/axiom" --version)" = "${packageJson.version}"
    # Load host-platform TUI helpers directly so missing native dependencies
    # fail the build rather than silently disabling clipboard support.
    ${nodejs}/bin/node -e \
      "const fs = require('node:fs');
       const path = require('node:path');
       const dir = '$out/lib/axiom/node_modules/@earendil-works/pi-tui/native/' + process.platform + '/prebuilds/' + process.platform + '-' + process.arch;
       if (fs.existsSync(dir)) {
         for (const file of fs.readdirSync(dir)) {
           if (file.endsWith('.node')) require(path.join(dir, file));
         }
       }"
    ${nodejs}/bin/node -e \
      "require('$out/lib/axiom/node_modules/@silvia-odwyer/photon-node')"
    runHook postInstallCheck
  '';

  meta = {
    description = packageJson.description;
    homepage = "https://pi.dev";
    license = lib.licenses.mit;
    mainProgram = "axiom";
    platforms = [
      "aarch64-darwin"
      "aarch64-linux"
      "x86_64-darwin"
      "x86_64-linux"
    ];
    sourceProvenance = with lib.sourceTypes; [
      fromSource
      binaryNativeCode
    ];
  };
}
