#!/usr/bin/env bash
set -euo pipefail

#############################################################################
# AntiHunter Command & Control Pro - Local Setup Script
# For development/local installations (macOS, Linux, Windows/WSL)
# No hardening, firewall, or reverse proxy - just gets the app running
#############################################################################

VERSION="1.0.0"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Color codes
if [[ -t 1 ]] && [[ "$(tput colors 2>/dev/null)" -ge 8 ]]; then
    RED='\033[0;31m'
    GREEN='\033[0;32m'
    YELLOW='\033[1;33m'
    BLUE='\033[0;34m'
    CYAN='\033[0;36m'
    MAGENTA='\033[0;35m'
    NC='\033[0m'
else
    RED=''
    GREEN=''
    YELLOW=''
    BLUE=''
    CYAN=''
    MAGENTA=''
    NC=''
fi

# Logging functions
log() { echo -e "${GREEN}[$(date '+%Y-%m-%d %H:%M:%S')]${NC} $*"; }
info() { echo -e "${CYAN}[INFO]${NC} $*"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }
error_exit() { error "$*"; exit 1; }
success() { echo -e "${GREEN}✓${NC} $*"; }
step() { echo -e "${MAGENTA}[STEP]${NC} $*"; }

# Detect OS
detect_os() {
    if [[ "$OSTYPE" == "darwin"* ]]; then
        OS="macos"
    elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
        OS="linux"
    elif [[ "$OSTYPE" == "msys" ]] || [[ "$OSTYPE" == "cygwin" ]]; then
        OS="windows"
    else
        error_exit "Unsupported OS: $OSTYPE"
    fi
    info "Detected OS: $OS"
}

# Configuration defaults
DB_NAME="command_center"
DB_USER="command_center"
DB_HOST="localhost"
DB_PORT="5432"
BACKEND_PORT="3000"
FRONTEND_PORT="5173"

# User input variables
DB_PASSWORD=""
ADMIN_EMAIL=""
ADMIN_PASSWORD=""
SITE_ID=""
SITE_NAME=""
SERIAL_DEVICE=""
SERIAL_BAUD="115200"

#############################################################################
# Interactive Configuration
#############################################################################

prompt_configuration() {
    echo ""
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${BLUE}  AntiHunter Command & Control Pro - Local Setup${NC}"
    echo -e "${BLUE}  Version: $VERSION${NC}"
    echo -e "${BLUE}═══════════════════════════════════════════════════════════════${NC}"
    echo ""

    # Site ID and Name
    read -p "Site ID [default]: " SITE_ID
    SITE_ID=${SITE_ID:-default}

    read -p "Site Name [$SITE_ID]: " SITE_NAME
    if [[ -z "$SITE_NAME" ]]; then
        if [[ "$SITE_ID" == "default" ]]; then
            SITE_NAME="Default Site"
        else
            SITE_NAME="$SITE_ID"
        fi
    fi

    # Database password
    echo ""
    DB_PASSWORD=$(openssl rand -base64 32 | tr -d "=+/" | cut -c1-32)
    info "Generated database password: $DB_PASSWORD"
    read -p "Press Enter to accept or type custom password: " custom_db_pass
    [[ -n "$custom_db_pass" ]] && DB_PASSWORD="$custom_db_pass"

    # Admin credentials
    echo ""
    read -p "Admin email [admin@example.com]: " ADMIN_EMAIL
    ADMIN_EMAIL=${ADMIN_EMAIL:-admin@example.com}

    ADMIN_PASSWORD=$(openssl rand -base64 16 | tr -d "=+/" | cut -c1-16)
    info "Generated admin password: $ADMIN_PASSWORD"
    read -p "Press Enter to accept or type custom password: " custom_admin_pass
    [[ -n "$custom_admin_pass" ]] && ADMIN_PASSWORD="$custom_admin_pass"

    # Serial device
    echo ""
    info "Serial device configuration (for mesh hardware)"
    echo "Common paths:"
    echo "  Linux:   /dev/ttyUSB0 or /dev/ttyACM0"
    echo "  macOS:   /dev/cu.usbserial-* or /dev/cu.usbmodem*"
    echo "  Windows: COM3, COM4, etc."
    read -p "Serial device path (or 'skip' to configure later): " SERIAL_DEVICE
    SERIAL_DEVICE=${SERIAL_DEVICE:-skip}

    if [[ "$SERIAL_DEVICE" != "skip" ]]; then
        read -p "Serial baud rate [115200]: " SERIAL_BAUD
        SERIAL_BAUD=${SERIAL_BAUD:-115200}
    fi

    # Summary
    echo ""
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${CYAN}Configuration Summary:${NC}"
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
    echo "Site ID:             $SITE_ID"
    echo "Site Name:           $SITE_NAME"
    echo "Database:            $DB_NAME"
    echo "DB User:             $DB_USER"
    echo "DB Password:         ${DB_PASSWORD:0:8}..."
    echo "Admin Email:         $ADMIN_EMAIL"
    echo "Admin Password:      ${ADMIN_PASSWORD}"
    echo "Backend Port:        $BACKEND_PORT"
    echo "Frontend Port:       $FRONTEND_PORT"
    if [[ "$SERIAL_DEVICE" == "skip" ]]; then
        echo "Serial Device:       <configure later>"
    else
        echo "Serial Device:       $SERIAL_DEVICE @ ${SERIAL_BAUD} baud"
    fi
    echo -e "${CYAN}═══════════════════════════════════════════════════════════════${NC}"
    echo ""

    read -p "Proceed with setup? (yes/no): " -r
    [[ "$REPLY" =~ ^[Yy][Ee][Ss]$ ]] || error_exit "Setup cancelled by user"
}

#############################################################################
# Dependency Checks & Installation
#############################################################################

check_node() {
    step "Checking Node.js installation..."

    if command -v node >/dev/null 2>&1; then
        local node_version
        node_version=$(node --version | cut -d'v' -f2 | cut -d'.' -f1)
        if [[ $node_version -ge 20 ]]; then
            success "Node.js $(node --version) found"
            return
        else
            warn "Found Node.js $node_version, but 20+ is required"
        fi
    fi

    error "Node.js 20+ not found"
    echo ""
    echo "Please install Node.js 20 LTS from:"
    echo "  https://nodejs.org/"
    echo ""
    if [[ "$OS" == "macos" ]]; then
        echo "Or install via Homebrew:"
        echo "  brew install node@20"
    elif [[ "$OS" == "linux" ]]; then
        echo "Or install via package manager:"
        echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
        echo "  sudo apt-get install -y nodejs"
    fi
    echo ""
    error_exit "Please install Node.js 20+ and re-run this script"
}

check_pnpm() {
    step "Checking pnpm installation..."

    if command -v pnpm >/dev/null 2>&1; then
        success "pnpm $(pnpm --version) found"
        return
    fi

    info "Installing pnpm..."
    if command -v corepack >/dev/null 2>&1; then
        corepack enable || error_exit "Failed to enable corepack"
        corepack prepare pnpm@latest --activate || error_exit "Failed to install pnpm"
        success "pnpm installed"
    else
        error_exit "Corepack not found. Please ensure Node.js 20+ is properly installed."
    fi
}

check_postgresql() {
    step "Checking PostgreSQL installation..."

    if command -v psql >/dev/null 2>&1; then
        success "PostgreSQL found: $(psql --version)"
        return
    fi

    error "PostgreSQL not found"
    echo ""
    echo "Please install PostgreSQL 14+ from:"
    if [[ "$OS" == "macos" ]]; then
        echo "  brew install postgresql@15"
        echo "  brew services start postgresql@15"
    elif [[ "$OS" == "linux" ]]; then
        echo "  sudo apt-get install postgresql postgresql-contrib"
    elif [[ "$OS" == "windows" ]]; then
        echo "  Download from: https://www.postgresql.org/download/windows/"
        echo "  Or use Docker: docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:15"
    fi
    echo ""
    error_exit "Please install PostgreSQL and re-run this script"
}

#############################################################################
# PostgreSQL Setup
#############################################################################

setup_postgresql() {
    step "Setting up PostgreSQL database..."

    # Check if database exists
    if psql -lqt 2>/dev/null | cut -d \| -f 1 | grep -qw "$DB_NAME"; then
        info "Database $DB_NAME already exists"
    else
        info "Creating database: $DB_NAME"
        if [[ "$OS" == "macos" ]] || [[ "$OS" == "linux" ]]; then
            createdb "$DB_NAME" 2>/dev/null || \
                sudo -u postgres createdb "$DB_NAME" || \
                error_exit "Failed to create database"
        else
            psql -U postgres -c "CREATE DATABASE $DB_NAME;" || \
                error_exit "Failed to create database"
        fi
    fi

    # Create user
    local create_user_sql="
DO \$\$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='$DB_USER') THEN
        CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';
    ELSE
        ALTER USER $DB_USER WITH PASSWORD '$DB_PASSWORD';
    END IF;
END
\$\$;
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
"

    if [[ "$OS" == "macos" ]] || [[ "$OS" == "linux" ]]; then
        echo "$create_user_sql" | psql postgres 2>/dev/null || \
            echo "$create_user_sql" | sudo -u postgres psql || \
            error_exit "Failed to create database user"
    else
        echo "$create_user_sql" | psql -U postgres || \
            error_exit "Failed to create database user"
    fi

    # Grant schema privileges
    local grant_schema_sql="GRANT ALL ON SCHEMA public TO $DB_USER;"
    PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "$grant_schema_sql" 2>/dev/null || \
        warn "Could not grant schema privileges (may not be critical)"

    # Test connection
    if PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -c "SELECT 1;" >/dev/null 2>&1; then
        success "PostgreSQL database configured"
    else
        error_exit "Cannot connect to database. Check PostgreSQL installation and credentials."
    fi
}

#############################################################################
# Application Setup
#############################################################################

install_dependencies() {
    step "Installing application dependencies..."

    cd "$REPO_DIR"

    pnpm install || error_exit "Failed to install dependencies"

    success "Dependencies installed"
}

create_backend_env() {
    step "Creating backend environment configuration..."

    local env_file="$REPO_DIR/apps/backend/.env"
    local database_url="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

    cat > "$env_file" <<EOF
# AntiHunter Command Center - Backend Configuration
# Generated by local setup script on $(date)

DATABASE_URL=$database_url
PORT=$BACKEND_PORT
HTTPS_ENABLED=false
HTTP_PREFIX=api
LOG_LEVEL=info

# Site Configuration
SITE_ID=$SITE_ID
SITE_NAME=$SITE_NAME

# Serial Configuration
EOF

    if [[ "$SERIAL_DEVICE" != "skip" ]]; then
        cat >> "$env_file" <<EOF
SERIAL_DEVICE=$SERIAL_DEVICE
SERIAL_BAUD=$SERIAL_BAUD
SERIAL_DATA_BITS=8
SERIAL_PARITY=none
SERIAL_STOP_BITS=1
SERIAL_DELIMITER=\\n
SERIAL_RECONNECT_BASE_MS=1000
SERIAL_RECONNECT_MAX_MS=15000
SERIAL_RECONNECT_JITTER=0.2
SERIAL_RECONNECT_MAX_ATTEMPTS=0
SERIAL_PROTOCOL=meshtastic-rewrite
EOF
    fi

    cat >> "$env_file" <<EOF

# Safety Protections (set to true if needed)
ALLOW_FOREVER=true
ALLOW_ERASE_FORCE=false

# Optional Features (configure in UI)
FPV_DECODER_ENABLED=true
DRONES_RECORD_INVENTORY=true

# Cluster
CLUSTER_WORKERS=1
EOF

    success "Backend environment configured at $env_file"
}

setup_database() {
    step "Setting up database schema..."

    cd "$REPO_DIR/apps/backend"

    # Generate Prisma client
    info "Generating Prisma client..."
    pnpm prisma:generate || error_exit "Failed to generate Prisma client"

    # Run migrations
    info "Running database migrations..."
    pnpm prisma migrate deploy || error_exit "Database migrations failed"

    # Seed database
    info "Seeding database..."
    export ADMIN_EMAIL="$ADMIN_EMAIL"
    export ADMIN_PASSWORD="$ADMIN_PASSWORD"
    export SITE_ID="$SITE_ID"
    export SITE_NAME="$SITE_NAME"

    pnpm prisma db seed || {
        warn "Seeding reported an error, checking if admin user was created..."
        local user_count
        user_count=$(PGPASSWORD="$DB_PASSWORD" psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT COUNT(*) FROM \"User\" WHERE email = '$ADMIN_EMAIL';" 2>/dev/null || echo "0")

        if [[ "$user_count" -eq 0 ]]; then
            error_exit "Database seeding failed"
        else
            success "Database seeded (admin user verified)"
        fi
    }

    success "Database setup complete"
}

#############################################################################
# Post-Setup Summary
#############################################################################

print_summary() {
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo -e "${GREEN}  Setup Complete!${NC}"
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo ""
    echo -e "${CYAN}Access Information:${NC}"
    echo "  Backend:          http://localhost:$BACKEND_PORT"
    echo "  Frontend:         http://localhost:$FRONTEND_PORT"
    echo "  Admin Email:      $ADMIN_EMAIL"
    echo "  Admin Password:   $ADMIN_PASSWORD"
    echo ""
    echo -e "${CYAN}Starting the Application:${NC}"
    echo ""
    echo "  Option 1 - Run both backend and frontend together:"
    echo "    ${GREEN}pnpm AHCC${NC}"
    echo ""
    echo "  Option 2 - Run backend and frontend separately (in 2 terminals):"
    echo "    Terminal 1 (Backend):"
    echo "      ${GREEN}cd apps/backend && pnpm dev${NC}"
    echo ""
    echo "    Terminal 2 (Frontend):"
    echo "      ${GREEN}cd apps/frontend && pnpm dev${NC}"
    echo ""
    echo -e "${CYAN}Useful Commands:${NC}"
    echo "  Start both:       ${GREEN}pnpm AHCC${NC}"
    echo "  Silent mode:      ${GREEN}pnpm AHCC:silent${NC}"
    echo "  Database studio:  ${GREEN}pnpm --filter @command-center/backend prisma:studio${NC}"
    echo "  View logs:        Check terminal output"
    echo ""
    if [[ "$SERIAL_DEVICE" == "skip" ]]; then
        echo -e "${YELLOW}Serial Device:${NC}"
        echo "  Serial device not configured. Configure it later in:"
        echo "    - Config -> Serial (in the UI)"
        echo "    - Or edit apps/backend/.env and restart"
        echo ""
    fi
    echo -e "${CYAN}Next Steps:${NC}"
    echo "  1. Start the application (see commands above)"
    echo "  2. Visit http://localhost:$FRONTEND_PORT and log in"
    echo "  3. Change admin password in Account settings"
    if [[ "$SERIAL_DEVICE" == "skip" ]]; then
        echo "  4. Configure Serial device (Config -> Serial)"
    fi
    echo ""
    echo -e "${GREEN}═══════════════════════════════════════════════════════════════${NC}"
    echo ""

    # Save credentials to file
    local creds_file="$REPO_DIR/local-setup-credentials.txt"
    cat > "$creds_file" <<EOF
AntiHunter Command Center - Local Setup Credentials
Generated: $(date)

Backend: http://localhost:$BACKEND_PORT
Frontend: http://localhost:$FRONTEND_PORT
Admin Email: $ADMIN_EMAIL
Admin Password: $ADMIN_PASSWORD

Database: $DB_NAME
DB User: $DB_USER
DB Password: $DB_PASSWORD

Site ID: $SITE_ID
Site Name: $SITE_NAME

To start: pnpm AHCC

IMPORTANT: Keep this file secure or delete it after saving credentials!
EOF

    chmod 600 "$creds_file"
    warn "Credentials saved to: $creds_file"
}

#############################################################################
# Main Execution
#############################################################################

main() {
    echo -e "${BLUE}"
    cat <<'EOF'
    ___          __  _ __  __            __
   /   |  ____  / /_(_) / / /_  ______  / /____  _____
  / /| | / __ \/ __/ / /_/ / / / / __ \/ __/ _ \/ ___/
 / ___ |/ / / / /_/ / __  / /_/ / / / / /_/  __/ /
/_/  |_/_/ /_/\__/_/_/ /_/\__,_/_/ /_/\__/\___/_/

         Command & Control Pro - Local Setup
EOF
    echo -e "${NC}"

    detect_os
    prompt_configuration

    echo ""
    log "Starting local setup..."
    echo ""

    # Check dependencies
    check_node
    check_pnpm
    check_postgresql

    # Setup database
    setup_postgresql

    # Setup application
    install_dependencies
    create_backend_env
    setup_database

    # Print summary
    print_summary
}

# Run main function
main "$@"
