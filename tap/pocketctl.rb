class Pocketctl < Formula
  desc "Remote AI coding agent control system"
  homepage "https://github.com/pocketctl/pocketctl"
  license "MIT"
  version "0.1.0"

  # Usage:
  #   brew tap pocketctl/tap
  #   brew install pocketctl
  #
  # To upgrade:
  #   brew upgrade pocketctl
  #
  # For production relay:
  #   pocketctl login --prod
  #   pocketctl daemon start --prod

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/pocketctl/pocketctl/releases/download/v#{version}/pocketctl_darwin_arm64"
      sha256 "__SHA256_DARWIN_ARM64__"
    else
      url "https://github.com/pocketctl/pocketctl/releases/download/v#{version}/pocketctl_darwin_amd64"
      sha256 "__SHA256_DARWIN_AMD64__"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/pocketctl/pocketctl/releases/download/v#{version}/pocketctl_linux_arm64"
      sha256 "__SHA256_LINUX_ARM64__"
    else
      url "https://github.com/pocketctl/pocketctl/releases/download/v#{version}/pocketctl_linux_amd64"
      sha256 "__SHA256_LINUX_AMD64__"
    end
  end

  def install
    # Homebrew handles binary naming automatically from the downloaded file
    if OS.mac?
      if Hardware::CPU.arm?
        bin.install "pocketctl_darwin_arm64" => "pocketctl"
      else
        bin.install "pocketctl_darwin_amd64" => "pocketctl"
      end
    elsif OS.linux?
      if Hardware::CPU.arm?
        bin.install "pocketctl_linux_arm64" => "pocketctl"
      else
        bin.install "pocketctl_linux_amd64" => "pocketctl"
      end
    end
  end

  # Add shell completion and man page support
  def caveats
    <<~EOS
      pocketctl has been installed!

      Quick start:
        pocketctl login
        pocketctl daemon start

      For production environment:
        pocketctl login --prod
        pocketctl daemon start --prod

      See https://github.com/pocketctl/pocketctl for more info.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/pocketctl version")
  end
end
