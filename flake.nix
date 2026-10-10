{
  description = "colorcube — interactive exploded RGB cube of xkcd color-survey names";

  inputs.nixpkgs.url = "https://channels.nixos.org/nixpkgs-unstable/nixexprs.tar.xz";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in {
      devShells = forAllSystems (pkgs:
        let
          python = pkgs.python3.withPackages (ps: with ps; [
            numpy
            scipy
            scikit-image
            pillow
          ]);
        in {
          default = pkgs.mkShell {
            packages = [ python pkgs.nodejs_22 ];
            shellHook = ''
              export PYTHONDONTWRITEBYTECODE=1
              export COLORCUBE_DEVSHELL=1
            '';
          };
        });
    };
}
