class Pocketctl < Formula
  desc "Remote AI coding agent control system"
  homepage "https://github.com/pocketctl/pocketctl"
  version "0.1.0"

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
    bin.install "pocketctl_darwin_arm64" => "pocketctl" if Hardware::CPU.arm? && OS.mac?
    bin.install "pocketctl_darwin_amd64" => "pocketctl" if !Hardware::CPU.arm? && OS.mac?
    bin.install "pocketctl_linux_arm64" => "pocketctl" if Hardware::CPU.arm? && OS.linux?
    bin.install "pocketctl_linux_amd64" => "pocketctl" if !Hardware::CPU.arm? && OS.linux?
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/pocketctl version")
  end
end
