from setuptools import setup

APP = ['main.py']
DATA_FILES = ['frontend', 'plugins']
OPTIONS = {
    'argv_emulation': True,
    'packages': ['fastapi', 'uvicorn', 'google.genai', 'keyring', 'starlette', 'webview'],
    'includes': ['server'],
    'plist': {
        'CFBundleName': 'Proactive Context',
        'CFBundleDisplayName': 'Proactive Context',
        'CFBundleGetInfoString': 'Proactive Context App',
        'CFBundleIdentifier': 'com.honchariw.proactivecontext',
        'CFBundleVersion': '1.0',
        'CFBundleShortVersionString': '1.0',
        'NSCameraUsageDescription': 'This app requires camera access to analyze video context during the interview.',
        'NSMicrophoneUsageDescription': 'This app requires microphone access to hear your spoken answers during the interview.',
        'LSUIElement': False, # Standard dock app
    }
}

setup(
    app=APP,
    data_files=DATA_FILES,
    options={'py2app': OPTIONS},
    setup_requires=['py2app'],
)
