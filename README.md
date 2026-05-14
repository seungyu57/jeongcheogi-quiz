# 정보처리기사 필기 기출 퀴즈

정적 HTML/CSS/JavaScript로 동작하는 정보처리기사 필기 기출 퀴즈 앱입니다. GitHub Pages에 그대로 배포할 수 있으며, Firebase Authentication과 Cloud Firestore를 사용해 로그인한 사용자의 진행률을 기기 간 동기화합니다.

## Firebase 설정

1. Firebase 콘솔에서 프로젝트를 만듭니다.
2. 프로젝트 설정의 웹 앱 추가에서 Web App을 등록합니다.
3. 발급된 Firebase Web SDK 설정값을 `app.js` 상단의 `firebaseConfig`에 붙여 넣습니다.
4. 현재 파일에는 제공된 `jeongcheogi-quiz` 프로젝트 설정이 들어 있습니다. 다른 프로젝트를 쓰면 이 값만 교체하면 됩니다.

```js
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID",
  appId: "YOUR_APP_ID"
};
```

## Google Authentication 활성화

1. Firebase 콘솔에서 Authentication으로 이동합니다.
2. Sign-in method에서 Google 제공업체를 사용 설정합니다.
3. 지원 이메일을 선택하고 저장합니다.
4. GitHub Pages 도메인을 사용할 경우 Authentication의 Authorized domains에 해당 도메인이 포함되어 있는지 확인합니다.

## Firestore 생성 및 규칙

1. Firebase 콘솔에서 Firestore Database를 만듭니다.
2. Production mode로 시작합니다.
3. 저장소 위치를 선택합니다.
4. 이 저장소의 `firestore.rules` 내용을 Firestore Rules에 배포합니다.

규칙은 로그인한 사용자가 자기 UID 아래의 문서만 읽고 쓸 수 있도록 제한합니다.

```text
users/{uid}
users/{uid}/quizProgress/{quizId}
```

## 동기화 데이터

진행률은 사용자별로 다음 경로에 저장됩니다.

```text
users/{uid}
users/{uid}/quizProgress/{quizId}
```

`quizId`는 `YYYY_RR` 형식입니다. 예: `2021_01`, `2025_03`.

각 회차 문서에는 선택 답안, 정오답 맵, 오답 번호, 과목별 점수, 총점, 평균, 마지막 문항, 완료 여부, 갱신 시간이 저장됩니다. 로그인하지 않은 경우에도 `localStorage`에 저장되며, 로그인 후 Firestore와 안전하게 병합됩니다.

## GitHub Pages 배포

1. 저장소에 `index.html`, `app.js`, `data.js`, `assets/`, `firestore.rules`를 커밋합니다.
2. GitHub 저장소 Settings > Pages로 이동합니다.
3. 배포 브랜치와 폴더를 선택합니다. 일반적으로 `main` 브랜치의 root를 사용합니다.
4. Pages URL이 만들어지면 Firebase Authentication의 Authorized domains에 GitHub Pages 도메인을 추가합니다.
5. 배포된 URL에서 Google 로그인을 테스트합니다.

## 로컬 테스트

정적 파일 서버에서 실행하는 것을 권장합니다.

```powershell
python -m http.server 8000
```

브라우저에서 `http://localhost:8000`을 열어 확인합니다. Firebase 연결이 되지 않아도 로컬 모드로 퀴즈를 풀 수 있습니다.
