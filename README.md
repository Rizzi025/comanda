# Comanda — sistema de pedidos para restaurante (Firebase)

Garçons lançam pedidos pelo celular, a cozinha acompanha em tempo real no computador e o administrador cuida do cardápio e da equipe. Tudo roda no Firebase (Hosting + Authentication + Firestore), no plano gratuito Spark.

## O que tem na pasta

```
comanda-firebase/
├── firebase.json            configuração do Hosting e do Firestore
├── .firebaserc              ID do seu projeto (você vai editar)
├── firestore.rules          regras de segurança do banco
├── firestore.indexes.json
└── public/                  o site
    ├── index.html
    ├── app.js               toda a lógica do sistema
    ├── styles.css
    ├── config.js            chaves do seu projeto (você vai editar)
    ├── manifest.webmanifest permite "instalar" no celular
    └── icon.svg
```

## Passo a passo

### 1. Criar o projeto no Firebase

1. Acesse https://console.firebase.google.com e clique em **Adicionar projeto**. Dê um nome (ex.: `comanda-restaurante`). O Google Analytics pode ficar desativado.
2. No menu **Build > Authentication**, clique em **Vamos começar**, abra a aba **Método de login** e ative **E-mail/senha**.
3. No menu **Build > Firestore Database**, clique em **Criar banco de dados**. Escolha a região `southamerica-east1 (São Paulo)` e comece em **modo de produção**.
4. Em **Configurações do projeto** (engrenagem) > **Seus apps**, clique no ícone **</>** (Web), registre o app com qualquer apelido e copie o objeto `firebaseConfig` que aparece.

### 2. Configurar os arquivos

1. Abra `public/config.js` e substitua os valores de exemplo pelo `firebaseConfig` copiado.
2. Abra `.firebaserc` e troque `COLOQUE-AQUI-O-ID-DO-PROJETO` pelo ID do projeto (aparece em Configurações do projeto, ex.: `comanda-restaurante-a1b2c`).

### 3. Publicar

Você precisa do Node.js instalado (https://nodejs.org, versão LTS). No terminal, dentro da pasta `comanda-firebase`:

```bash
npm install -g firebase-tools
firebase login
firebase deploy
```

No final aparece o endereço do sistema, algo como `https://comanda-restaurante-a1b2c.web.app`.

### 4. Primeiro acesso

1. Abra o endereço no computador e clique em **Criar conta de administrador**.
2. Escolha um usuário e uma senha, informe seu nome e o nome do restaurante.
3. Na aba **Gestão**, cadastre o cardápio, defina o número de mesas e crie os acessos da equipe:
   - **Garçom**: vê só a tela de lançar pedidos.
   - **Cozinha**: vê só o painel de comandas.
   - **Administrador**: vê tudo.

Faça o primeiro acesso logo depois de publicar: a opção de criar administrador só fica disponível até o primeiro administrador ser criado.

### 5. Usar no dia a dia

- **Computador da cozinha**: entre com um usuário de Cozinha e clique em **Ligar som de aviso** (o navegador exige um clique antes de tocar som). Deixe a tela aberta.
- **Celular dos garçons**: abra o endereço, entre e use **Adicionar à tela inicial** (Chrome: menu ⋮; iPhone/Safari: botão Compartilhar). O sistema passa a abrir como um aplicativo.
- Um único usuário de Cozinha pode ficar logado em várias telas ao mesmo tempo. Garçons funcionam melhor com um usuário cada, porque o aviso de "pedido pronto" vai para quem lançou o pedido.
- No fim do expediente, use **Gestão > Limpeza** para apagar os pedidos entregues e cancelados.

## Segurança

- Só quem tem acesso criado pelo administrador consegue ver ou alterar dados. As regras em `firestore.rules` garantem isso no servidor, não apenas na tela.
- Garçons e cozinha não conseguem mexer no cardápio, na equipe nem apagar pedidos.
- As chaves em `config.js` não são segredo: o Firebase foi feito para elas ficarem no site. A proteção vem das regras.
- **Remover** alguém na aba Equipe corta o acesso na hora. A conta de login continua existindo em Authentication; se quiser apagá-la de vez, faça isso no console do Firebase.
- **Trocar a senha** de alguém: remova o acesso e crie de novo com outro usuário, ou redefina pelo console do Firebase (Authentication > usuário > ⋮).

## Custos

O plano gratuito do Firestore permite 50 mil leituras e 20 mil gravações por dia, suficiente para um restaurante pequeno ou médio. Cada tela aberta lê os pedidos quando eles mudam, então manter a limpeza diária em dia ajuda a ficar dentro da cota. Acompanhe o uso em **Firestore > Uso** no console.

## Atualizar o sistema

Depois de alterar qualquer arquivo, rode `firebase deploy` de novo. Para publicar só as regras: `firebase deploy --only firestore:rules`. Só o site: `firebase deploy --only hosting`.
