# Toki Reader Studio

허가받은 작품의 회차 링크 수집, 이미지 저장, 보관함 관리,
세로 스크롤 열람, 정적 웹 리더 내보내기를 한 화면에서 처리하는
Windows 데스크톱 앱입니다.

## 주요 기능

- 작품 목록 URL에서 회차 링크 자동 수집
- 시작/마지막 회차 범위 필터
- 직접 정리한 `회차,URL` 목록 붙여넣기
- 선택 회차 일괄 다운로드
- `.vw-imgs img.viewer-ratio-img` 본문 요소를 렌더링 순서대로 캡처
- 완료 회차 자동 건너뛰기
- 세로 스크롤 로컬 리더
- 작품별 보관함
- Vercel 등에 올릴 수 있는 정적 웹 리더 폴더 생성
- Windows 설치형 및 Portable EXE 빌드 설정

## 앱에서 사용하는 흐름

1. 수집 탭에서 작품 목록 URL을 입력합니다.
2. 시작 회차와 마지막 회차를 설정합니다.
3. `회차 목록 가져오기`를 누릅니다.
4. 필요한 회차만 체크합니다.
5. `선택 회차 다운로드`를 누릅니다.
6. 보관함 또는 리더 탭에서 바로 읽습니다.
7. 외부에 배포해야 한다면 내보내기 탭에서 정적 리더 폴더를 만듭니다.

CSV 파일을 따로 만들거나 PowerShell로 크롤러 명령을 매번 입력할 필요가 없습니다.

## 명령어 없이 Windows EXE 만들기

프로젝트 전체를 GitHub 저장소에 업로드한 뒤:

1. GitHub 저장소의 `Actions` 탭으로 이동합니다.
2. 왼쪽에서 `Build Windows App`을 선택합니다.
3. `Run workflow`를 누릅니다.
4. 작업 완료 후 하단 Artifacts에서
   `Toki-Reader-Studio-Windows`를 다운로드합니다.
5. 압축 안의 설치형 또는 Portable EXE를 실행합니다.

워크플로 파일은 다음 위치에 이미 포함되어 있습니다.

```text
.github/workflows/build-windows.yml
```

## 개발 환경에서 실행

```powershell
npm install
npm start
```

Windows 설치 파일 생성:

```powershell
npm run dist:win
```

## 데이터 저장 위치

기본 보관함은 Electron의 사용자 데이터 폴더 아래 `library`입니다.
앱의 설정 탭에서 원하는 폴더로 바꿀 수 있습니다.

구조:

```text
library/
└─ 작품명-작품ID/
   ├─ series.json
   └─ episodes/
      └─ 0599/
         ├─ 0001.png
         ├─ 0002.png
         └─ manifest.json
```

## 정적 리더 배포

앱의 내보내기 탭에서 작품을 선택해 배포용 폴더를 만듭니다.

결과:

```text
작품명-reader/
├─ index.html
├─ app.js
├─ styles.css
├─ data.json
├─ vercel.json
└─ episodes/
```

이 폴더를 별도 GitHub 저장소에 올린 다음 Vercel에서 Import하면 됩니다.
프레임워크는 `Other`, 빌드 명령은 비워 둡니다.

## 중요한 제한

- 데스크톱 앱은 사용자의 PC에서 원격 페이지를 열고 이미지를 캡처합니다.
- Vercel에 배포되는 것은 크롤러가 아니라 내보낸 정적 리더입니다.
- 로그인, 캡차, DRM 또는 접근 제한을 우회하지 않습니다.
- 제작자 또는 권리자가 허용한 자료에만 사용하세요.
- 공개 배포 권한과 다운로드 허가는 서로 다를 수 있으므로 각각 확인하세요.
