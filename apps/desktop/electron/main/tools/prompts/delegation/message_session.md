Deliver a user-side fact into a work session. It is not a system instruction.
intent "answer" delivers the text as the user's answer to that session.
intent "amend" relays the user's words as "来自项目代理转达：用户说……". If the session is waiting on the user, that relay is the answer and the session resumes. If the session is still running, the relay is applied when the next turn starts. Do not use amend to stop a session; call cancel_session for that.
