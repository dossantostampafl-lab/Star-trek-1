# Star Trek 1 na Oracle Cloud (grátis)

Guia para colocar a estação na internet numa VM **Always Free** da Oracle, com HTTPS, senha de acesso
e o FreeLLMAPI rodando na mesma máquina. Tempo: ~30 minutos.

```
Internet ──https──▶ Caddy (443) ──▶ Star Trek 1 (127.0.0.1:8787) ──▶ FreeLLMAPI (127.0.0.1:3001)
                                         └─▶ Docker (terminal dos agentes, sem internet)
```

Só as portas 22 (SSH), 80 e 443 ficam abertas. A estação e o FreeLLMAPI escutam apenas dentro da VM.

## 1. Criar a VM

No painel da Oracle Cloud: **Compute → Instances → Create instance**

- **Image:** Canonical Ubuntu 24.04 (ou 22.04)
- **Shape:** Ampere **VM.Standard.A1.Flex** — 2 OCPUs e 12 GB de RAM já sobram (o Always Free vai até 4 OCPUs / 24 GB)
- **Networking:** deixe criar a VCN com sub-rede pública e marque **Assign a public IPv4 address**
- **SSH keys:** envie a sua chave pública (ou baixe a gerada)

Se aparecer "Out of capacity" para A1, tente outra *Availability Domain* ou mais tarde.

## 2. Abrir as portas 80 e 443 na Oracle

**Networking → Virtual Cloud Networks →** sua VCN **→ Security Lists → Default Security List → Add Ingress Rules**:

| Source CIDR | Protocolo | Porta de destino |
| --- | --- | --- |
| `0.0.0.0/0` | TCP | `80` |
| `0.0.0.0/0` | TCP | `443` |

Não abra a 3001 nem a 8787. (O firewall interno da VM o script de instalação ajusta sozinho.)

## 3. Baixar o projeto na VM

```bash
ssh ubuntu@IP_DA_VM
sudo mkdir -p /opt/star-trek-1 && sudo chown ubuntu:ubuntu /opt/star-trek-1
git clone https://github.com/dossantostampafl-lab/Star-trek-1.git /opt/star-trek-1
```

O repositório é privado, então o `git clone` pede usuário e senha: use seu usuário do GitHub e um
**token** (GitHub → Settings → Developer settings → Personal access tokens → *Fine-grained*, só com
leitura de *Contents* deste repositório) no lugar da senha.

## 4. Instalar

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

## 5. Configurar o FreeLLMAPI

O FreeLLMAPI junta os planos grátis de vários provedores (Groq, Google AI Studio, Mistral, OpenRouter…).
Ele precisa que **você cadastre as chaves grátis desses provedores** no painel dele, e gera uma
**chave unificada** (`freellmapi-...`) que o Star Trek 1 usa.

No **seu PC**, abra um túnel SSH (o painel não fica exposto na internet):

```bash
ssh -L 3001:127.0.0.1:3001 ubuntu@IP_DA_VM
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

## 6. Usar

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

- **O endereço não abre:** confira a Security List (passo 2) e `sudo iptables -L INPUT -n | head`.
  O certificado só é emitido com as portas 80/443 abertas: `journalctl -u caddy -n 50`.
- **"Com PUBLIC_URL definida, ACCESS_PASSWORD é obrigatória":** a senha no `.env` precisa ter 12+ caracteres.
- **`✗ /models respondeu HTTP 401`:** falta a chave `FREELLMAPI_KEY` (passo 5).
- **O instalador do FreeLLMAPI falhou:** instale à mão seguindo o README dele
  (https://github.com/tashfeenahmed/freellmapi) e garanta que a porta fique `127.0.0.1:3001:3001` no compose.
- **Terminal aparece "sem docker":** `sudo systemctl status docker` e `sudo -u startrek docker ps`.
