import { createContext, useContext } from "react";
export const AuthContext = createContext({
  password: "",
  setPassword: (_value: string) => {},
});
export const useAuth = () => useContext(AuthContext);
