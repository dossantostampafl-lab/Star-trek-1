# Star Trek 1 na Oracle Cloud (grátis)

Guia para colocar a estação na internet numa VM **Always Free** da Oracle, com HTTPS, senha de acesso
e o FreeLLMAPI rodando na mesma máquina. Tempo: ~30 minutos.

```
Internet ──https──▶ Caddy (443) ──▶ Star Trek 1 (127.0.0.1:8787) ──▶ FreeLLMAPI (127.0.0.1:3001)
                                         └─▶ Docker (terminal dos agentes, sem internet)
```

Só as portas 22 (SSH), 80 e 443 ficam abertas. A estação e o FreeLLMAPI escutam apenas dentro da VM.

## Só com tablet ou celular?

Dá para fazer tudo sem computador:

- **Painel da Oracle:** funciona no navegador do tablet.
- **Chave SSH:** na criação da VM (passo 2), escolha **Generate a key pair for me** e toque em
  **Save private key**. Pule o passo 1.
- **Terminal SSH:** instale o app **Termius** (iPad/Android), vá em *Keychain → Import key* e importe o
  arquivo baixado. Crie um host com o IP da VM, usuário `ubuntu` e essa chave.
  (Alternativa sem app: **Cloud Shell**, o terminal que abre no topo do painel da Oracle.)
- **Painel do FreeLLMAPI:** instale com `sudo bash deploy/oracle/setup.sh --painel-fllm`. O painel abre em
  `https://fllm.SEU-IP.sslip.io` (usuário `admin`, senha = senha da estação), sem túnel SSH. Depois de
  configurar, rode o setup de novo **sem** a opção para fechar o painel.

## Antes de começar

- Conta na Oracle Cloud (oracle.com/cloud/free). O cadastro pede cartão só para verificação.
- A **região principal (home region)** escolhida no cadastro é definitiva, e os recursos grátis só existem nela.
- Limite grátis atual do Ampere A1 (reduzido pela Oracle em junho de 2026): **2 OCPUs e 12 GB de RAM** no total,
  e **200 GB** de disco somando todas as VMs.
- A Oracle pode recuperar VMs grátis que ficam ociosas por muito tempo; a estação rodando normalmente costuma
  evitar isso, mas faça backup de `/var/lib/startrek` de vez em quando.

## 1. Criar a chave SSH (no seu PC)

No PowerShell (Windows) ou terminal (Mac/Linux):

```bash
ssh-keygen -t ed25519 -f ~/.ssh/oracle_st1
```

Aperte Enter para aceitar (ou defina uma frase-senha). Isso cria `oracle_st1` (privada, fica no PC) e
`oracle_st1.pub` (pública, vai para a Oracle).

## 2. Criar a VM

No painel da Oracle: menu **☰ → Compute → Instances → Create instance**.

1. **Name:** `star-trek-1`.
2. **Placement:** deixe o padrão (se der erro de capacidade, volte aqui e troque o *Availability domain*).
3. **Image and shape → Change image:** *Ubuntu* → **Canonical Ubuntu 24.04** → Select.
4. **Change shape:** *Virtual machine* → **Ampere** → **VM.Standard.A1.Flex** → **2 OCPUs** e **12 GB** de memória → Select.
   Confira se aparece o selo *Always Free-eligible*.
5. **Networking:** *Create new virtual cloud network* e *Create new public subnet* (padrões) e marque
   **Automatically assign public IPv4 address**.
6. **Add SSH keys:** *Upload public key files (.pub)* → escolha `oracle_st1.pub`.
7. **Boot volume:** deixe o padrão (cerca de 47 GB).
8. **Create**. Em 1–2 minutos o estado fica **Running**. Copie o **Public IP address**.

**"Out of capacity for shape VM.Standard.A1.Flex"** é comum: tente outro *Availability domain*, 1 OCPU / 6 GB,
ou de novo mais tarde (madrugada costuma funcionar).

## 3. Abrir as portas 80 e 443 na Oracle

Na página da VM: **Primary VNIC → Subnet →** (clique na sub-rede) **→ Security Lists → Default Security List →
Add Ingress Rules**. Adicione duas regras:

| Source CIDR | IP Protocol | Destination Port Range |
| --- | --- | --- |
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

Não abra a 3001 nem a 8787. (O firewall interno da VM o script de instalação ajusta sozinho.)

## 4. Entrar na VM e baixar o projeto

No seu PC:

```bash
ssh -i ~/.ssh/oracle_st1 ubuntu@IP_DA_VM
```

Na VM:

```bash
sudo mkdir -p /opt/star-trek-1 && sudo chown ubuntu:ubuntu /opt/star-trek-1
git clone https://github.com/dossantostampafl-lab/Star-trek-1.git /opt/star-trek-1
```

## 5. Instalar

```bash
cd /opt/star-trek-1
sudo bash deploy/oracle/setup.sh
```

O script instala Node 22, Docker e Caddy, libera 80/443 no firewall da VM, cria o usuário de serviço
`startrek`, gera o `.env` com uma **senha de acesso** e o endereço `https://SEU-IP.sslip.io`, instala o
FreeLLMAPI preso em `127.0.0.1`, cria o serviço `star-trek-1` e configura o HTTPS.

No fim ele mostra o **endereço** e a **senha**. Guarde a senha.

Tem domínio próprio? Aponte um registro A para o IP da VM e rode
`sudo DOMAIN=estacao.seudominio.com bash deploy/oracle/setup.sh`.

## 6. Configurar o FreeLLMAPI

O FreeLLMAPI junta os planos grátis de vários provedores (Groq, Google AI Studio, Mistral, OpenRouter…).
Ele precisa que **você cadastre as chaves grátis desses provedores** no painel dele, e gera uma
**chave unificada** (`freellmapi-...`) que o Star Trek 1 usa.

**Pelo tablet:** use o painel web (`--painel-fllm`, veja "Só com tablet ou celular?").

**Pelo PC**, abra um túnel SSH (o painel não fica exposto na internet):

```bash
ssh -i ~/.ssh/oracle_st1 -L 3001:127.0.0.1:3001 ubuntu@IP_DA_VM
```

Com o túnel aberto, acesse `http://localhost:3001` no navegador:

1. Crie a conta (e-mail + senha — ficam só na sua VM).
2. Em **Keys**, adicione as chaves grátis de pelo menos um provedor.
3. Copie a chave unificada que aparece no topo do painel.

Na VM:

```bash
sudo nano /opt/star-trek-1/.env        # cole em FREELLMAPI_KEY=
sudo systemctl restart star-trek-1
cd /opt/star-trek-1 && node cli.js --check
```

Deve aparecer `✓ servidor respondeu` e `✓ chat funcionando`.

## 7. Usar

Abra o endereço (`https://SEU-IP.sslip.io`), digite a senha e recrute o primeiro tripulante.
Funciona no celular e no tablet também.

## Dia a dia

| Tarefa | Comando (na VM) |
| --- | --- |
| Ver o log | `journalctl -u star-trek-1 -f` |
| Reiniciar | `sudo systemctl restart star-trek-1` |
| Atualizar do GitHub | `cd /opt/star-trek-1 && sudo bash deploy/oracle/update.sh` |
| Trocar a senha | edite `ACCESS_PASSWORD` no `.env` e reinicie (todas as sessões caem) |
| Backup | copie `/var/lib/startrek` (banco, checkpoints e pastas dos tripulantes) |
| Log do FreeLLMAPI | `cd ~/freellmapi && docker compose logs -f` |

## Segurança — o que já vem feito

- HTTPS com certificado automático (Caddy + Let's Encrypt).
- Senha obrigatória quando `PUBLIC_URL` está definida; cookie `HttpOnly`/`Secure`/`SameSite=Strict`,
  válido por 30 dias; 5 tentativas erradas por IP bloqueiam por 15 minutos.
- A estação só aceita o endereço público configurado (Host e Origem checados) e um token por inicialização.
- O serviço roda com usuário próprio (`startrek`), sem acesso de escrita fora de `/var/lib/startrek`.
- Terminal dos agentes em container sem internet, com o mesmo usuário do serviço.

**Atenção:** o usuário `startrek` está no grupo `docker`, e quem controla o Docker tem poder de root na VM.
É o preço do terminal em container. Se não for usar terminal, rode `sudo gpasswd -d startrek docker`
e reinicie — a estação detecta e desliga a ferramenta.

## Problemas comuns

- **O endereço não abre:** confira a Security List (passo 3) e `sudo iptables -L INPUT -n | head`.
  O certificado só é emitido com as portas 80/443 abertas: `journalctl -u caddy -n 50`.
- **"Com PUBLIC_URL definida, ACCESS_PASSWORD é obrigatória":** a senha no `.env` precisa ter 12+ caracteres.
- **`✗ /models respondeu HTTP 401`:** falta a chave `FREELLMAPI_KEY` (passo 6).
- **O instalador do FreeLLMAPI falhou:** instale à mão seguindo o README dele
  (https://github.com/tashfeenahmed/freellmapi) e garanta que a porta fique `127.0.0.1:3001:3001` no compose.
- **Terminal aparece "sem docker":** `sudo systemctl status docker` e `sudo -u startrek docker ps`.
