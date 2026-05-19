const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const circ = ["①", "②", "③", "④"];
const FIREBASE_SDK_VERSION = "12.7.0";

const firebaseConfig = {
  apiKey: "AIzaSyDH1GP8jcFAriqdYNQfyjxnSum6RDIvSmg",
  authDomain: "jeongcheogi-quiz.firebaseapp.com",
  projectId: "jeongcheogi-quiz",
  storageBucket: "jeongcheogi-quiz.firebasestorage.app",
  messagingSenderId: "769705498807",
  appId: "1:769705498807:web:91fe97f92515e930649532",
  measurementId: "G-TP58VSBXGD",
};

let state = {
  view: "loading",
  year: null,
  exam: null,
  idx: 0,
  wrongMode: false,
  wrongList: null,
  wrongPracticeAnswers: {},
};

let firebaseApp = null;
let firebaseAuth = null;
let firebaseDb = null;
let firebaseModules = null;
let firebaseReady = false;
let firebaseInitPromise = null;
let unsubscribeAuth = null;
let currentUser = null;
let localMode = false;
let booted = false;

const saveTimers = new Map();
const pendingProgress = new Map();

function buildQuizId(year, round) {
  return `${year}_${String(round).padStart(2, "0")}`;
}

function quizIdForExam(exam) {
  return buildQuizId(exam.year, exam.round);
}

function examByQuizId(quizId) {
  return QUIZ_DATA.find((exam) => quizIdForExam(exam) === quizId) || null;
}

function legacyKeyFor(exam) {
  return `ipe_quiz_${exam.year}_${exam.round}`;
}

function progressKeyFor(exam) {
  return `ipe_quiz_progress_${quizIdForExam(exam)}`;
}

function ansChoices(answer) {
  if (answer === "전항정답") return circ;
  return (answer || "").match(/[①②③④]/g) || [];
}

function ansText(answer) {
  return answer === "전항정답" ? "전항정답(①②③④)" : ansChoices(answer).join(" 또는 ");
}

function isCorrect(picked, answer) {
  return ansChoices(answer).includes(picked);
}

function toast(text, duration = 1200) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), duration);
}

function years() {
  return [...new Set(QUIZ_DATA.map((exam) => exam.year))].sort((a, b) => b - a);
}

function examsByYear(year) {
  return QUIZ_DATA.filter((exam) => exam.year === year).sort((a, b) => a.round - b.round);
}

function setView(view) {
  ["loadingView", "authView", "homeView", "roundView", "quizView", "listView"].forEach((id) => {
    $(`#${id}`).classList.add("hidden");
  });
  $(`#${view}View`).classList.remove("hidden");
  $("#bottomNav").classList.toggle("hidden", view !== "quiz");
  $("#progress").classList.toggle("hidden", view !== "quiz");
  state.view = view;
}

function setSyncStatus(text, kind = "local") {
  const el = $("#syncStatus");
  el.textContent = text;
  el.className = `syncStatus ${kind}`;
}

function syncStatusText() {
  return $("#syncStatus")?.textContent || (currentUser ? "클라우드 저장 대기" : "로컬 저장됨");
}

function updateAuthUI() {
  const label = $("#authUser");
  const loginButtons = $$('[data-action="google-login"]');
  const logoutButton = $("#logoutBtn");

  if (currentUser) {
    const display = currentUser.displayName || currentUser.email || "로그인 사용자";
    label.textContent = `${display}로 로그인됨`;
    loginButtons.forEach((button) => button.classList.add("hidden"));
    logoutButton.classList.remove("hidden");
    return;
  }

  label.textContent = localMode ? "로컬 모드 사용 중" : "로그인하면 클라우드에 저장됩니다";
  loginButtons.forEach((button) => button.classList.remove("hidden"));
  logoutButton.classList.add("hidden");
}

async function initFirebase() {
  if (firebaseReady) return true;
  if (firebaseInitPromise) return firebaseInitPromise;

  firebaseInitPromise = (async () => {
    try {
      const [appModule, authModule, firestoreModule] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-auth.js`),
        import(`https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore.js`),
      ]);

      firebaseModules = {
        initializeApp: appModule.initializeApp,
        getAuth: authModule.getAuth,
        GoogleAuthProvider: authModule.GoogleAuthProvider,
        signInWithPopup: authModule.signInWithPopup,
        signOut: authModule.signOut,
        onAuthStateChanged: authModule.onAuthStateChanged,
        setPersistence: authModule.setPersistence,
        browserLocalPersistence: authModule.browserLocalPersistence,
        getFirestore: firestoreModule.getFirestore,
        collection: firestoreModule.collection,
        doc: firestoreModule.doc,
        getDocs: firestoreModule.getDocs,
        setDoc: firestoreModule.setDoc,
        deleteDoc: firestoreModule.deleteDoc,
        serverTimestamp: firestoreModule.serverTimestamp,
      };

      firebaseApp = firebaseModules.initializeApp(firebaseConfig);
      firebaseAuth = firebaseModules.getAuth(firebaseApp);
      await firebaseModules
        .setPersistence(firebaseAuth, firebaseModules.browserLocalPersistence)
        .catch(() => {});
      firebaseDb = firebaseModules.getFirestore(firebaseApp);
      firebaseReady = true;
      return true;
    } catch (error) {
      console.warn("Firebase initialization failed. Local mode is still available.", error);
      firebaseReady = false;
      firebaseInitPromise = null;
      setSyncStatus("Firebase 연결 실패: 로컬 저장 사용", "error");
      return false;
    }
  })();

  return firebaseInitPromise;
}

function onAuthChanged() {
  if (!firebaseReady || !firebaseAuth || !firebaseModules) {
    showAuthView();
    return;
  }

  if (unsubscribeAuth) unsubscribeAuth();
  unsubscribeAuth = firebaseModules.onAuthStateChanged(firebaseAuth, async (user) => {
    currentUser = user;
    localMode = false;
    updateAuthUI();

    if (!user) {
      setSyncStatus("로그인하면 클라우드에 저장됩니다", "local");
      showAuthView();
      return;
    }

    setView("loading");
    $("#appTitle").textContent = "학습 기록 동기화";
    $("#appSub").textContent = "클라우드 진행률을 불러오는 중";
    setSyncStatus("클라우드 불러오는 중", "local");

    try {
      await saveUserProfile(user);
      await loadUserProgress(user.uid);
      setSyncStatus("클라우드 저장 완료", "cloud");
    } catch (error) {
      console.warn("Could not load cloud progress. Continuing with local progress.", error);
      setSyncStatus("로컬 저장됨", "local");
      toast("오프라인 저장됨");
    }

    renderHome();
  });
}

async function signInWithGoogle() {
  const ready = await initFirebase();
  if (!ready || !firebaseAuth || !firebaseModules) {
    toast("Firebase 연결을 확인해 주세요");
    return;
  }

  try {
    const provider = new firebaseModules.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await firebaseModules.signInWithPopup(firebaseAuth, provider);
  } catch (error) {
    console.warn("Google sign-in failed.", error);
    toast("로그인에 실패했습니다");
  }
}

async function signOutUser() {
  if (firebaseReady && firebaseAuth && firebaseModules) {
    await firebaseModules.signOut(firebaseAuth).catch((error) => {
      console.warn("Sign-out failed.", error);
    });
  }
  currentUser = null;
  localMode = false;
  updateAuthUI();
  showAuthView();
}

async function saveUserProfile(user) {
  const ref = firebaseModules.doc(firebaseDb, "users", user.uid);
  await firebaseModules.setDoc(
    ref,
    {
      profile: {
        email: user.email || "",
        displayName: user.displayName || "",
        photoURL: user.photoURL || "",
        lastLoginAt: firebaseModules.serverTimestamp(),
        updatedAt: firebaseModules.serverTimestamp(),
      },
    },
    { merge: true },
  );
}

async function loadUserProgress(uid) {
  if (!firebaseReady || !firebaseDb || !firebaseModules) return;

  const cloudByQuizId = new Map();
  const progressRef = firebaseModules.collection(firebaseDb, "users", uid, "quizProgress");
  const snapshot = await firebaseModules.getDocs(progressRef);
  snapshot.forEach((docSnap) => {
    cloudByQuizId.set(docSnap.id, docSnap.data());
  });

  const uploadTasks = [];

  for (const exam of QUIZ_DATA) {
    const quizId = quizIdForExam(exam);
    const localProgress = loadLocalProgress(exam);
    const cloudProgress = cloudByQuizId.has(quizId)
      ? normalizeProgressForExam(exam, cloudByQuizId.get(quizId))
      : null;
    const merged = mergeProgress(localProgress, cloudProgress);

    if (!merged) continue;

    const normalized = normalizeProgressForExam(exam, merged);
    saveLocalProgress(exam, normalized);

    const localIsNewer = getUpdatedAtMs(localProgress) > getUpdatedAtMs(cloudProgress);
    const cloudMissing = !cloudProgress;
    const mergedHasMoreAnswers =
      countAnswers(normalized) > countAnswers(cloudProgress) &&
      getUpdatedAtMs(normalized) >= getUpdatedAtMs(cloudProgress);

    if (cloudMissing || localIsNewer || mergedHasMoreAnswers) {
      uploadTasks.push(saveUserProgress(uid, quizId, normalized, { silent: true }));
    }
  }

  if (uploadTasks.length) {
    await Promise.allSettled(uploadTasks);
  }
}

async function saveUserProgress(uid, quizId, progress, options = {}) {
  if (!firebaseReady || !firebaseDb || !firebaseModules || !uid) return null;

  const exam = examByQuizId(quizId);
  if (!exam) return null;

  const savedAt = getUpdatedAtMs(progress);
  const updatedAtMs = savedAt > 1 ? savedAt : Date.now();
  const normalized = normalizeProgressForExam(exam, { ...progress, updatedAtMs });
  const payload = {
    ...normalized,
    updatedAtMs,
    updatedAt: firebaseModules.serverTimestamp(),
  };

  await firebaseModules.setDoc(
    firebaseModules.doc(firebaseDb, "users", uid, "quizProgress", quizId),
    payload,
    { merge: true },
  );

  if (!options.silent) {
    setSyncStatus("클라우드 저장 완료", "cloud");
  }

  return payload;
}

function mergeProgress(localProgress, cloudProgress) {
  if (!localProgress && !cloudProgress) return null;
  if (!localProgress) return cloudProgress;
  if (!cloudProgress) return localProgress;

  const localTime = getUpdatedAtMs(localProgress);
  const cloudTime = getUpdatedAtMs(cloudProgress);
  const newer = localTime > cloudTime ? localProgress : cloudProgress;
  const older = newer === localProgress ? cloudProgress : localProgress;
  const newerAnswers = getProgressAnswers(newer);
  const olderAnswers = getProgressAnswers(older);
  const shouldPreserveOlderAnswers = countAnswerMap(olderAnswers) > countAnswerMap(newerAnswers);
  const answers = shouldPreserveOlderAnswers ? { ...olderAnswers, ...newerAnswers } : newerAnswers;

  return {
    ...newer,
    answers,
    currentQuestion: newer.currentQuestion || older.currentQuestion,
    completed: Boolean(newer.completed || older.completed),
    updatedAtMs: Math.max(localTime, cloudTime),
  };
}

function getUpdatedAtMs(progress) {
  if (!progress) return 0;
  if (Number.isFinite(progress.updatedAtMs)) return Number(progress.updatedAtMs);
  if (Number.isFinite(progress.updatedAt)) return Number(progress.updatedAt);

  const value = progress.updatedAt;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value && Number.isFinite(value.seconds)) {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1000000);
  }
  return 0;
}

function normalizeProgressForExam(exam, raw = {}) {
  const answers = cleanAnswers(exam, getProgressAnswers(raw));
  const updatedAtMs = getUpdatedAtMs(raw);
  const currentQuestion = normalizeQuestionNumber(
    exam,
    raw.currentQuestion || firstUnansweredQuestionNo(exam, answers),
  );
  return buildProgressFromAnswers(exam, answers, {
    currentQuestion,
    completed: Boolean(raw.completed),
    updatedAtMs,
  });
}

function buildProgressFromAnswers(exam, answers, options = {}) {
  const clean = cleanAnswers(exam, answers);
  const correctMap = {};
  const wrongQuestions = [];

  for (const question of exam.questions) {
    const picked = clean[question.no];
    if (!picked) continue;
    const correct = isCorrect(picked, question.answer);
    correctMap[question.no] = correct;
    if (!correct) wrongQuestions.push(question.no);
  }

  const subjectScores = calculateSubjectScores(exam, clean);
  const totalCorrect = Object.values(correctMap).filter(Boolean).length;
  const totalWrong = wrongQuestions.length;
  const totalScore = totalCorrect * 5;
  const averageScore = Math.round((totalScore / 5) * 10) / 10;
  const updatedAtMs = Number.isFinite(options.updatedAtMs) && options.updatedAtMs > 0
    ? Number(options.updatedAtMs)
    : Date.now();

  return {
    quizId: quizIdForExam(exam),
    year: exam.year,
    round: exam.round,
    answers: clean,
    correctMap,
    wrongQuestions,
    subjectScores,
    totalCorrect,
    totalWrong,
    totalScore,
    averageScore,
    currentQuestion: normalizeQuestionNumber(
      exam,
      options.currentQuestion || firstUnansweredQuestionNo(exam, clean),
    ),
    completed: Boolean(options.completed || Object.keys(clean).length === exam.questions.length),
    updatedAt: new Date(updatedAtMs).toISOString(),
    updatedAtMs,
  };
}

function calculateSubjectScores(exam, answers = null) {
  const record = answers || {};
  const scores = {};

  for (let index = 0; index < 5; index += 1) {
    const subjectNo = index + 1;
    const start = index * 20 + 1;
    const end = start + 19;
    let correct = 0;
    let wrong = 0;
    let done = 0;

    for (const question of exam.questions) {
      if (question.no < start || question.no > end) continue;
      const picked = record[question.no];
      if (!picked) continue;
      done += 1;
      if (isCorrect(picked, question.answer)) correct += 1;
      else wrong += 1;
    }

    const score = correct * 5;
    scores[String(subjectNo)] = {
      subject: subjectNo,
      start,
      end,
      done,
      correct,
      wrong,
      score,
      passed: score >= 40,
    };
  }

  return scores;
}

function subjectBreakdown(exam) {
  const progress = loadLocalProgress(exam);
  const scores = calculateSubjectScores(exam, progress?.answers || {});
  return Object.values(scores).map((item) => ({
    name: `${item.subject}과목`,
    start: item.start,
    end: item.end,
    done: item.done,
    good: item.correct,
    bad: item.wrong,
    score: item.score,
    passed: item.passed,
  }));
}

function getProgressAnswers(progress) {
  if (!progress) return {};
  if (progress.answers && typeof progress.answers === "object" && !Array.isArray(progress.answers)) {
    return progress.answers;
  }
  return progress;
}

function cleanAnswers(exam, answers) {
  const validQuestionNumbers = new Set(exam.questions.map((question) => String(question.no)));
  const cleaned = {};
  Object.entries(answers || {}).forEach(([questionNo, picked]) => {
    if (!validQuestionNumbers.has(String(questionNo))) return;
    if (!circ.includes(picked)) return;
    cleaned[String(questionNo)] = picked;
  });
  return cleaned;
}

function countAnswers(progress) {
  return countAnswerMap(getProgressAnswers(progress));
}

function countAnswerMap(answers) {
  return Object.keys(answers || {}).length;
}

function normalizeQuestionNumber(exam, value) {
  const number = Number(value);
  if (exam.questions.some((question) => question.no === number)) return number;
  return exam.questions[0]?.no || 1;
}

function firstUnansweredQuestionNo(exam, answers) {
  const first = exam.questions.find((question) => !answers[String(question.no)]);
  return (first || exam.questions[0])?.no || 1;
}

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function loadLocalProgress(exam) {
  const modern = readJson(progressKeyFor(exam));
  if (modern && (modern.answers || modern.currentQuestion || modern.quizId)) {
    return normalizeProgressForExam(exam, modern);
  }

  const legacy = readJson(legacyKeyFor(exam));
  if (legacy && typeof legacy === "object" && countAnswerMap(legacy) > 0) {
    return buildProgressFromAnswers(exam, legacy, {
      currentQuestion: firstUnansweredQuestionNo(exam, legacy),
      completed: false,
      updatedAtMs: 1,
    });
  }

  return null;
}

function saveLocalProgress(exam, progress) {
  const normalized = normalizeProgressForExam(exam, progress);
  try {
    localStorage.setItem(progressKeyFor(exam), JSON.stringify(normalized));
    localStorage.setItem(legacyKeyFor(exam), JSON.stringify(normalized.answers));
  } catch (error) {
    console.warn("Local save failed.", error);
    toast("로컬 저장 공간을 확인해 주세요");
  }
  return normalized;
}

function removeLocalProgress(exam) {
  localStorage.removeItem(progressKeyFor(exam));
  localStorage.removeItem(legacyKeyFor(exam));
}

function getRecord() {
  if (!state.exam) return {};
  return loadLocalProgress(state.exam)?.answers || {};
}

function answeredCount(exam) {
  return countAnswers(loadLocalProgress(exam));
}

function score(exam) {
  const record = loadLocalProgress(exam)?.answers || {};
  let good = 0;
  let bad = 0;
  for (const question of exam.questions) {
    const picked = record[question.no];
    if (!picked) continue;
    if (isCorrect(picked, question.answer)) good += 1;
    else bad += 1;
  }
  return { good, bad, done: good + bad, total: exam.questions.length };
}

function currentQuestions() {
  return state.wrongMode && state.wrongList ? state.wrongList : state.exam.questions;
}

function currentQuestionNo() {
  const questions = currentQuestions();
  return questions[state.idx]?.no || state.exam?.questions[0]?.no || 1;
}

function persistCurrentProgress(options = {}) {
  if (!state.exam) return null;

  const existing = loadLocalProgress(state.exam);
  const progress = buildProgressFromAnswers(state.exam, existing?.answers || {}, {
    currentQuestion: currentQuestionNo(),
    completed: options.completed || existing?.completed || false,
    updatedAtMs: Date.now(),
  });

  saveLocalProgress(state.exam, progress);

  if (currentUser && firebaseReady) {
    setSyncStatus("클라우드 저장 중", "local");
    if (options.immediate) {
      flushCloudProgress(progress.quizId, progress);
    } else {
      scheduleCloudSave(progress);
    }
  } else {
    setSyncStatus("로컬 저장됨", "local");
  }

  return progress;
}

function scheduleCloudSave(progress) {
  pendingProgress.set(progress.quizId, progress);
  if (saveTimers.has(progress.quizId)) {
    clearTimeout(saveTimers.get(progress.quizId));
  }
  saveTimers.set(
    progress.quizId,
    setTimeout(() => flushCloudProgress(progress.quizId), 800),
  );
}

async function flushCloudProgress(quizId, overrideProgress = null) {
  if (!currentUser || !firebaseReady) return;

  const progress = overrideProgress || pendingProgress.get(quizId);
  if (!progress) return;

  pendingProgress.delete(quizId);
  if (saveTimers.has(quizId)) {
    clearTimeout(saveTimers.get(quizId));
    saveTimers.delete(quizId);
  }

  try {
    await saveUserProgress(currentUser.uid, quizId, progress);
  } catch (error) {
    console.warn("Cloud save failed. Local progress is kept.", error);
    pendingProgress.set(quizId, progress);
    setSyncStatus("로컬 저장됨", "local");
    toast("오프라인 저장됨");
  }
}

async function deleteCloudProgress(exam) {
  if (!currentUser || !firebaseReady || !firebaseDb || !firebaseModules) return;
  await firebaseModules.deleteDoc(
    firebaseModules.doc(firebaseDb, "users", currentUser.uid, "quizProgress", quizIdForExam(exam)),
  );
}

function showAuthView() {
  updateAuthUI();
  $("#appTitle").textContent = "정보처리기사 필기 퀴즈";
  $("#appSub").textContent = "로그인 또는 로컬 모드 선택";
  setView("auth");
}

function continueLocalMode() {
  localMode = true;
  currentUser = null;
  updateAuthUI();
  setSyncStatus("로컬 저장됨", "local");
  renderHome();
}

function renderHome() {
  setView("home");
  $("#appTitle").textContent = "정보처리기사 필기 퀴즈";
  $("#appSub").textContent = `총 ${QUIZ_DATA.length}회차 · ${QUIZ_DATA.reduce((sum, exam) => sum + exam.questions.length, 0)}문항`;

  const total = QUIZ_DATA.reduce((sum, exam) => sum + exam.questions.length, 0);
  const done = QUIZ_DATA.reduce((sum, exam) => sum + answeredCount(exam), 0);
  $("#allStats").innerHTML = `<div class="stat"><b>${QUIZ_DATA.length}</b><span>회차</span></div><div class="stat"><b>${total}</b><span>전체 문항</span></div><div class="stat"><b>${done}</b><span>푼 문항</span></div>`;
  $("#yearGrid").innerHTML = years()
    .map((year) => {
      const exams = examsByYear(year);
      const questionCount = exams.reduce((sum, exam) => sum + exam.questions.length, 0);
      const doneCount = exams.reduce((sum, exam) => sum + answeredCount(exam), 0);
      return `<button class="yearBtn" data-year="${year}"><b>${year}년</b><span>${exams.length}회차 · ${doneCount}/${questionCount}문항 풀이</span></button>`;
    })
    .join("");

  $$(".yearBtn").forEach((button) => {
    button.onclick = () => renderRounds(Number(button.dataset.year));
  });
}

function renderRounds(year) {
  state.year = year;
  setView("round");
  $("#appTitle").textContent = `${year}년`;
  $("#appSub").textContent = "회차 선택";
  $("#roundGrid").innerHTML = examsByYear(year)
    .map((exam) => {
      const stats = score(exam);
      return `<button class="roundBtn" data-round="${exam.round}"><b>${exam.round}회</b><span>${stats.done}/${stats.total} 풀이 · 정답 ${stats.good} · 오답 ${stats.bad}</span></button>`;
    })
    .join("");

  $$(".roundBtn").forEach((button) => {
    button.onclick = () => startExam(QUIZ_DATA.find((exam) => exam.year === state.year && exam.round === Number(button.dataset.round)));
  });
}

function startExam(exam, idx = null) {
  const progress = loadLocalProgress(exam);
  const targetIndex = idx ?? exam.questions.findIndex((question) => question.no === progress?.currentQuestion);

  state.exam = exam;
  state.idx = targetIndex >= 0 ? targetIndex : 0;
  state.wrongMode = false;
  state.wrongList = null;
  state.wrongPracticeAnswers = {};
  renderQuiz();
}

function renderQuiz() {
  setView("quiz");
  const exam = state.exam;
  const questions = currentQuestions();

  if (!questions.length) {
    state.wrongMode = false;
    state.wrongList = null;
    state.wrongPracticeAnswers = {};
    toast("오답이 없어. 클린 그 자체");
    renderQuiz();
    return;
  }

  if (state.idx >= questions.length) state.idx = questions.length - 1;
  if (state.idx < 0) state.idx = 0;

  const question = questions[state.idx];
  const record = state.wrongMode ? state.wrongPracticeAnswers : getRecord();
  $("#appTitle").textContent = `${exam.year}년 ${exam.round}회`;
  $("#appSub").textContent = state.wrongMode ? "오답만 다시 풀기" : "전체 문제 풀기";
  $("#qNo").textContent = `${question.no}번`;
  $("#subject").textContent = question.subject;
  $("#qImg").src = question.image;
  $("#qImg").alt = `${exam.year}년 ${exam.round}회 ${question.no}번 문제`;
  $("#choices").innerHTML = circ.map((choice) => `<button class="choice" data-choice="${choice}">${choice}</button>`).join("");

  const picked = record[question.no];
  if (picked) markChoices(picked, question.answer);

  $$(".choice").forEach((button) => {
    button.onclick = () => choose(button.dataset.choice);
  });

  $("#feedback").className = "feedback";
  $("#feedback").textContent = "";
  hideExplanation();
  if (picked) showFeedback(picked, question.answer, false);
  renderExamStats();
  $("#progress>div").style.width = `${(((state.idx + 1) / questions.length) * 100).toFixed(1)}%`;
  $("#prevBtn").disabled = state.idx === 0;
  $("#nextBtn").textContent = state.idx === questions.length - 1 ? "마지막" : "다음";
  persistCurrentProgress();
}

function markChoices(picked, answer) {
  const goods = ansChoices(answer);
  $$(".choice").forEach((button) => {
    button.classList.toggle("selected", button.dataset.choice === picked);
    button.classList.toggle("correct", goods.includes(button.dataset.choice));
    button.classList.toggle("wrong", button.dataset.choice === picked && !goods.includes(picked));
  });
}

function hideExplanation() {
  const explanation = $("#explanation");
  if (!explanation) return;
  explanation.className = "explanation";
  explanation.innerHTML = "";
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
}

function showExplanation(picked, answer) {
  const question = currentQuestions()[state.idx];
  const explanation = $("#explanation");
  if (!explanation) return;

  const body = question.explanation || "해설 데이터가 없습니다.";
  explanation.className = "explanation show";
  explanation.innerHTML = `<div class="exTitle">교재식 해설</div><div class="exLine"><b>정답</b><span class="exCorrect">${esc(ansText(answer))}</span></div><div class="exLine"><b>내 선택</b><span class="exMine">${esc(picked || "미선택")}</span></div><div class="exBody">${esc(body)}</div>`;
}

function showFeedback(picked, answer, pop = true) {
  const feedback = $("#feedback");
  const ok = isCorrect(picked, answer);
  hideExplanation();
  feedback.className = `feedback show ${ok ? "good" : "bad"}`;

  if (ok) {
    feedback.textContent = "정답!";
  } else {
    feedback.innerHTML = '오답!<br><button type="button" class="explainBtn" id="explainBtn">해설 보기</button>';
    const explainButton = $("#explainBtn");
    if (explainButton) explainButton.onclick = () => showExplanation(picked, answer);
  }

  if (pop) toast(ok ? "정답!" : "오답 저장!");
}

function choose(choice) {
  const exam = state.exam;
  const question = currentQuestions()[state.idx];
  const current = loadLocalProgress(exam);
  const answers = { ...(current?.answers || {}), [String(question.no)]: choice };
  const progress = buildProgressFromAnswers(exam, answers, {
    currentQuestion: question.no,
    completed: current?.completed || false,
    updatedAtMs: Date.now(),
  });

  if (state.wrongMode) {
    state.wrongPracticeAnswers[String(question.no)] = choice;
  }

  saveLocalProgress(exam, progress);
  if (currentUser && firebaseReady) {
    setSyncStatus("클라우드 저장 중", "local");
    scheduleCloudSave(progress);
  } else {
    setSyncStatus("로컬 저장됨", "local");
  }

  markChoices(choice, question.answer);
  showFeedback(choice, question.answer);
  renderExamStats();
}

function renderExamStats() {
  const stats = score(state.exam);
  $("#examStats").innerHTML = `<div class="stat"><b>${stats.done}/${stats.total}</b><span>풀이</span></div><div class="stat"><b>${stats.good}</b><span>정답</span></div><div class="stat"><b>${stats.bad}</b><span>오답</span></div>`;
}

function move(delta) {
  state.idx += delta;
  renderQuiz();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderList() {
  setView("list");
  const exam = state.exam;
  $("#appTitle").textContent = `${exam.year}년 ${exam.round}회 문항표`;
  $("#appSub").textContent = "문항 바로가기";
  const record = loadLocalProgress(exam)?.answers || {};
  $("#numList").innerHTML = exam.questions
    .map((question) => {
      let className = "";
      if (record[question.no]) className = isCorrect(record[question.no], question.answer) ? "good" : "bad";
      return `<button class="numBtn ${className}" data-no="${question.no}">${question.no}</button>`;
    })
    .join("");

  $$(".numBtn").forEach((button) => {
    button.onclick = () => {
      state.wrongMode = false;
      state.wrongList = null;
      state.wrongPracticeAnswers = {};
      state.idx = state.exam.questions.findIndex((question) => question.no === Number(button.dataset.no));
      renderQuiz();
    };
  });
}

function finish() {
  const stats = score(state.exam);
  const subjects = subjectBreakdown(state.exam);
  const totalScore = subjects.reduce((sum, subject) => sum + subject.score, 0);
  const average = Math.round((totalScore / 5) * 10) / 10;
  const subjectLines = subjects
    .map((subject) => `${subject.name} (${subject.start}-${subject.end}번): ${subject.score}점 / 100점 (${subject.good}/20정답, 풀이 ${subject.done}/20)${subject.passed ? "" : " 과락"}`)
    .join("\n");

  persistCurrentProgress({ completed: true, immediate: true });

  alert(`${state.exam.year}년 ${state.exam.round}회 결과

[전체]
풀이: ${stats.done}/${stats.total}
정답: ${stats.good}
오답: ${stats.bad}
정답률: ${stats.done ? Math.round((stats.good / stats.done) * 100) : 0}%
총점: ${totalScore}/500
평균: ${average}점
저장: ${syncStatusText()}

[과목별 점수]
${subjectLines}`);
}

async function resetExamProgress(exam) {
  removeLocalProgress(exam);
  pendingProgress.delete(quizIdForExam(exam));
  if (saveTimers.has(quizIdForExam(exam))) {
    clearTimeout(saveTimers.get(quizIdForExam(exam)));
    saveTimers.delete(quizIdForExam(exam));
  }

  try {
    await deleteCloudProgress(exam);
    if (currentUser) setSyncStatus("클라우드 저장 완료", "cloud");
  } catch (error) {
    console.warn("Cloud reset failed. Local reset is kept.", error);
    setSyncStatus("로컬 저장됨", "local");
    toast("오프라인 저장됨");
  }
}

function bindEvents() {
  $("#homeBtn").onclick = () => {
    if (!currentUser && !localMode) showAuthView();
    else renderHome();
  };
  $("#backToYears").onclick = renderHome;
  $("#prevBtn").onclick = () => move(-1);
  $("#nextBtn").onclick = () => move(1);
  $("#finishBtn").onclick = finish;
  $("#openList").onclick = renderList;
  $("#backToQuiz").onclick = renderQuiz;
  $("#localModeBtn").onclick = continueLocalMode;
  $("#logoutBtn").onclick = signOutUser;
  $$('[data-action="google-login"]').forEach((button) => {
    button.onclick = signInWithGoogle;
  });

  $("#showAnswer").onclick = () => {
    const question = currentQuestions()[state.idx];
    const record = state.wrongMode ? state.wrongPracticeAnswers : getRecord();
    markChoices(record[question.no] || "", question.answer);
    const feedback = $("#feedback");
    feedback.className = "feedback show good";
    feedback.textContent = `정답은 ${ansText(question.answer)} 입니다.`;
    showExplanation(record[question.no] || "미선택", question.answer);
  };

  $("#onlyWrong").onclick = () => {
    const record = loadLocalProgress(state.exam)?.answers || {};
    state.wrongList = state.exam.questions.filter((question) => record[question.no] && !isCorrect(record[question.no], question.answer));
    state.wrongMode = true;
    state.wrongPracticeAnswers = {};
    state.idx = 0;
    renderQuiz();
  };

  $("#resetExam").onclick = async () => {
    if (!confirm("이 회차 풀이 기록을 지울까요?")) return;
    await resetExamProgress(state.exam);
    renderQuiz();
  };

  $("#resetYear").onclick = async () => {
    if (!confirm(`${state.year}년 기록을 전부 지울까요?`)) return;
    const exams = examsByYear(state.year);
    for (const exam of exams) {
      await resetExamProgress(exam);
    }
    renderRounds(state.year);
  };

  $("#goFirstWrong").onclick = () => {
    const record = loadLocalProgress(state.exam)?.answers || {};
    const index = state.exam.questions.findIndex((question) => record[question.no] && !isCorrect(record[question.no], question.answer));
    if (index >= 0) {
      state.idx = index;
      renderQuiz();
    } else {
      toast("오답이 없어. 이건 거의 방탄유리 멘탈");
    }
  };

  document.addEventListener("keydown", (event) => {
    if (state.view !== "quiz") return;
    if (["1", "2", "3", "4"].includes(event.key)) choose(circ[Number(event.key) - 1]);
    if (event.key === "ArrowRight") move(1);
    if (event.key === "ArrowLeft") move(-1);
  });

  window.addEventListener("online", async () => {
    if (!currentUser) return;
    try {
      await loadUserProgress(currentUser.uid);
      setSyncStatus("클라우드 저장 완료", "cloud");
    } catch {
      setSyncStatus("로컬 저장됨", "local");
    }
  });
}

async function boot() {
  if (booted) return;
  booted = true;
  bindEvents();
  updateAuthUI();
  setView("loading");
  const ready = await initFirebase();
  if (ready) onAuthChanged();
  else showAuthView();
}

boot();
