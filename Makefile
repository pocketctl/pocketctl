VERSION ?= $(shell git describe --tags --always --dirty 2>/dev/null || echo "dev")
LDFLAGS = -ldflags "-X main.version=$(VERSION)"
BINARY = pocketctl
GOOS ?= $(shell uname -s | tr '[:upper:]' '[:lower:]')
GOARCH ?= $(shell uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')

.PHONY: build build-all clean relay web dev dev-relay test test-opencode-managed test-opencode-managed-release release

-include .env
export JWT_SECRET
export DEV_EMAIL
export DEV_EMAIL_CODE

# ---------- 构建 ----------

## 构建 Daemon 二进制（当前平台）
build:
	go build $(LDFLAGS) -o $(BINARY) ./cmd/pocketctl
	@echo "✅ 构建: $(BINARY) ($(VERSION))"

## 构建 Relay
relay:
	cd relay && npm run build
	@echo "✅ Relay 构建完成"

## 构建 Web UI
web:
	cd web && npm run build && rm -f vite.config.js vite.config.d.ts
	@echo "✅ Web UI 构建完成"

## 构建所有平台二进制
build-all:
	@echo "构建所有平台..."
	@mkdir -p dist
	GOOS=darwin GOARCH=arm64 go build $(LDFLAGS) -o dist/pocketctl_darwin_arm64 ./cmd/pocketctl
	GOOS=darwin GOARCH=amd64 go build $(LDFLAGS) -o dist/pocketctl_darwin_amd64 ./cmd/pocketctl
	GOOS=linux  GOARCH=amd64 go build $(LDFLAGS) -o dist/pocketctl_linux_amd64 ./cmd/pocketctl
	GOOS=linux  GOARCH=arm64 go build $(LDFLAGS) -o dist/pocketctl_linux_arm64 ./cmd/pocketctl
	GOOS=windows GOARCH=amd64 go build $(LDFLAGS) -o dist/pocketctl_windows_amd64.exe ./cmd/pocketctl
	GOOS=windows GOARCH=arm64 go build $(LDFLAGS) -o dist/pocketctl_windows_arm64.exe ./cmd/pocketctl
	@echo "✅ 全平台构建完成，正在生成 SHA256 校验和..."
	@cd dist && for f in pocketctl_*; do if [ -f "$$f" ]; then shasum -a 256 "$$f" | awk '{print $$1}' > "$${f}.sha256"; fi; done
	@echo "✅ SHA256 校验和已生成: dist/*.sha256"

# ---------- 开发 ----------

## 启动本地开发环境（Landing + Web + Relay 统一走 80 端口）
dev:
	@echo "启动开发环境..."
	@$(MAKE) web
	@echo ""
	@echo "重启 Docker 服务（volume mount 本地 web/dist/）..."
	@docker compose up -d landing web relay
	@echo ""
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@echo "  ✅ 开发环境已就绪"
	@echo "  Landing Page:  http://localhost/"
	@echo "  Web 客户端:    http://localhost/app/"
	@echo "  Relay API:     http://localhost/api/"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

## 启动本地 Relay（tsx 直跑，快速迭代 relay 代码）
dev-relay:
	cd relay && DATABASE_URL="postgresql://pocketctl:pocketctl@localhost:5432/pocketctl" npx tsx src/server.ts

# ---------- 测试 ----------

## 运行所有测试
test:
	go test ./internal/...
	cd relay && npx vitest run
	cd web && npx vitest run

## 运行 Go 测试
test-go:
	go test -v ./internal/...

## 运行 E2E 测试
test-e2e:
	go test -v -tags=e2e ./internal/e2e/...

## OpenCode 受管终端 A-D 回归（Go/Windows 编译/Relay/Web/iOS 源码回归）
test-opencode-managed:
	bash scripts/test-opencode-managed.sh

## OpenCode 受管终端完整发布门禁（额外执行 Relay/Web、六平台和 iOS 构建）
test-opencode-managed-release:
	POCKETCTL_RELEASE_GATE=1 bash scripts/test-opencode-managed.sh

# ---------- iOS ----------

## iOS Debug 构建
ios:
	bash scripts/ios-build.sh debug

## iOS Archive + IPA
ios-archive:
	bash scripts/ios-build.sh release

## iOS 上传到 TestFlight
ios-beta:
	bash scripts/ios-beta.sh

## iOS 版本管理
ios-version:
	bash scripts/ios-version.sh

## iOS 版本递增（patch/minor/major）
ios-bump:
	bash scripts/ios-version.sh $(filter-out $@,$(MAKECMDGOALS))

# ---------- 发布 ----------

## 创建 GitHub Release
release:
	@if [ "$(VERSION)" = "dev" ]; then echo "❌ 请指定版本: make release VERSION=v0.1.0"; exit 1; fi
	@echo "发布 $(VERSION)..."
	git tag -a $(VERSION) -m "Release $(VERSION)"
	git push github $(VERSION)
	@echo "✅ Tag 已推送到 GitHub，GitHub Actions 将自动构建和发布"

# ---------- 清理 ----------

clean:
	rm -f $(BINARY)
	rm -rf dist/
	@echo "✅ 清理完成"

# ---------- 部署辅助 ----------

## 打包部署文件
dist: build-all relay web
	@mkdir -p dist/deploy
	cp deploy/deploy.sh dist/deploy/
	cp deploy/systemd/pocketctl-relay.service dist/deploy/
	cp deploy/nginx/pocketctl.conf dist/deploy/
	cp scripts/install-daemon.sh dist/deploy/install.sh
	@echo "✅ 部署包已生成: dist/"

## 帮助
help:
	@echo "pocketctl Makefile"
	@echo ""
	@echo "构建:"
	@echo "  make build       构建 Daemon 二进制"
	@echo "  make relay       构建 Relay"
	@echo "  make web         构建 Web UI"
	@echo "  make build-all   构建全平台二进制"
	@echo "  make ios         iOS Debug 构建"
	@echo "  make ios-archive iOS Release Archive + IPA"
	@echo "  make ios-beta    iOS 上传到 TestFlight"
	@echo ""
	@echo "开发:"
	@echo "  make dev         启动本地开发环境"
	@echo ""
	@echo "测试:"
	@echo "  make test        运行所有测试"
	@echo "  make test-go     运行 Go 测试"
	@echo "  make test-opencode-managed          运行 OpenCode 受管终端 A-D 回归"
	@echo "  make test-opencode-managed-release  运行 OpenCode 受管终端完整发布门禁"
	@echo ""
	@echo "发布:"
	@echo "  make release VERSION=v0.1.0  创建发布"
	@echo ""
	@echo "部署:"
	@echo "  make dist        打包所有部署文件"
